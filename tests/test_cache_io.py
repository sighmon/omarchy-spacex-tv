import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import select
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cache_io', Path(__file__).resolve().parents[1] / 'cache_io.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.temp.name))
        self.path = self.root / 'cache' / 'data'

    def tearDown(self):
        self.temp.cleanup()

    def parent(self):
        return cache.cache_parent(str(self.path))

    def test_publish_and_read(self):
        parent, name = self.parent()
        try:
            fd = cache.publish(parent, name, b'hello')
            try:
                self.assertEqual(os.read(fd, 10), b'hello')
                self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o600)
            finally:
                os.close(fd)
            self.assertEqual(cache.cached_bytes(parent, name, 10), b'hello')
            self.assertEqual(os.listdir(self.path.parent), ['data'])
        finally:
            os.close(parent)

    def test_symlink_ancestor_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        self.path.parent.symlink_to(outside)
        with self.assertRaises(OSError):
            self.parent()
        self.assertEqual(list(outside.iterdir()), [])

    def test_writable_ancestor_rejected(self):
        self.path.parent.mkdir(mode=0o777)
        self.path.parent.chmod(0o777)
        with self.assertRaises(ValueError):
            self.parent()

    def test_foreign_owner_rejected(self):
        info = type('Info', (), {'st_mode': stat.S_IFDIR | 0o700, 'st_uid': os.geteuid() + 1000})()
        with patch.object(cache.os, 'fstat', return_value=info):
            with self.assertRaises(ValueError):
                self.parent()

    def test_leaf_symlink_never_read_or_followed_for_publication(self):
        parent, name = self.parent()
        outside = self.root / 'outside'
        outside.write_bytes(b'untouched')
        self.path.symlink_to(outside)
        try:
            with self.assertRaises(OSError):
                cache.cached_bytes(parent, name, 100)
            fd = cache.publish(parent, name, b'new')
            os.close(fd)
            self.assertEqual(outside.read_bytes(), b'untouched')
            self.assertEqual(self.path.read_bytes(), b'new')
        finally:
            os.close(parent)

    def test_directory_replacement_cannot_redirect_publication(self):
        parent, name = self.parent()
        original = self.root / 'original'
        outside = self.root / 'outside'
        outside.mkdir()
        self.path.parent.rename(original)
        self.path.parent.symlink_to(outside)
        try:
            fd = cache.publish(parent, name, b'new')
            os.close(fd)
            self.assertEqual((original / name).read_bytes(), b'new')
            self.assertEqual(list(outside.iterdir()), [])
        finally:
            os.close(parent)

    def test_staging_collision_fails_without_touching_target(self):
        parent, name = self.parent()
        trap = self.path.parent / '.spacex-collision'
        outside = self.root / 'outside'
        outside.write_bytes(b'untouched')
        trap.symlink_to(outside)
        try:
            with patch.object(cache.secrets, 'token_hex', return_value='collision'):
                with self.assertRaises(FileExistsError):
                    cache.publish(parent, name, b'bad')
            self.assertEqual(outside.read_bytes(), b'untouched')
            self.assertTrue(trap.is_symlink())
        finally:
            os.close(parent)

    def test_reject_nonregular_hardlinked_and_oversized_fallbacks(self):
        parent, name = self.parent()
        try:
            os.mkfifo(self.path)
            with self.assertRaises(ValueError):
                cache.cached_bytes(parent, name, 10)
            self.path.unlink()
            self.path.write_bytes(b'large')
            with self.assertRaises(ValueError):
                cache.cached_bytes(parent, name, 2)
            os.link(self.path, self.root / 'hardlink')
            with self.assertRaises(ValueError):
                cache.cached_bytes(parent, name, 10)
        finally:
            os.close(parent)

    def test_failed_publication_cleans_staging_preserves_old_cache(self):
        parent, name = self.parent()
        self.path.write_bytes(b'old')
        try:
            with patch.object(cache.os, 'replace', side_effect=OSError('failure')):
                with self.assertRaises(OSError):
                    cache.publish(parent, name, b'new')
            self.assertEqual(self.path.read_bytes(), b'old')
            self.assertEqual(os.listdir(self.path.parent), ['data'])
        finally:
            os.close(parent)

    def test_failed_download_uses_checked_fallback(self):
        parent, name = self.parent()
        os.close(parent)
        self.path.write_bytes(b'old')
        output = type('Output', (), {'buffer': io.BytesIO()})()
        with patch.object(cache, 'download', side_effect=ValueError('failed')), patch.object(cache.sys, 'stdout', output):
            cache.run('json', str(self.path), 1, 100, 'https://example.test', True)
        self.assertEqual(output.buffer.getvalue(), b'old')
        self.assertEqual(self.path.read_bytes(), b'old')

    def test_download_enforces_limit_without_trusting_curl(self):
        proc = unittest.mock.MagicMock()
        proc.__enter__.return_value = proc
        proc.stdout = io.BytesIO(b'123456789')
        proc.wait.return_value = 0
        with patch.object(cache.subprocess, 'Popen', return_value=proc):
            with self.assertRaises(ValueError):
                cache.download('https://example.test', 1, 5)
        proc.kill.assert_called_once()

    def test_viewer_receives_open_inode(self):
        def view(executable, args):
            fd = int(args[-1].rsplit('/', 1)[-1])
            self.assertEqual(executable, '/bin/swayimg')
            self.assertTrue(os.get_inheritable(fd))
            self.assertEqual(args, ['/bin/swayimg', '-f', '/proc/self/fd/' + str(fd)])
            self.path.unlink()
            self.path.write_bytes(b'replacement')
            self.assertEqual(os.read(fd, 10), b'image')
        with patch.object(cache, 'download', return_value=b'image'), patch.object(cache.shutil, 'which', return_value='/bin/swayimg'), patch.object(cache.os, 'execv', side_effect=view):
            cache.run('image', str(self.path), 1, 100, 'https://example.test', False)

    def test_image_download_failure_opens_original_url(self):
        url = 'https://example.test/image?name=orig'
        for failure in (OSError('curl unavailable'), ValueError('timeout'), ValueError('oversized')):
            with self.subTest(failure=failure), patch.object(cache, 'download', side_effect=failure), patch.object(cache.os, 'execvp') as opener:
                cache.run('image', str(self.path), 1, 100, url, False)
                opener.assert_called_once_with('xdg-open', ['xdg-open', url])
                self.assertFalse(self.path.exists())

    def test_missing_viewer_opens_original_url(self):
        url = 'https://example.test/image'
        with patch.object(cache, 'download', return_value=b'image'), patch.object(cache.shutil, 'which', return_value=None), patch.object(cache.os, 'execvp') as opener:
            cache.run('image', str(self.path), 1, 100, url, False)
            opener.assert_called_once_with('xdg-open', ['xdg-open', url])

    def test_viewer_replaces_helper_and_terminates_with_tracked_pid(self):
        viewer = self.root / 'viewer'
        viewer.write_text(
            '#!' + sys.executable + '\n'
            'import json, os, signal, sys\n'
            'fd = int(sys.argv[-1].rsplit("/", 1)[-1])\n'
            'print(json.dumps([os.getpid(), os.read(fd, 100).decode()]), flush=True)\n'
            'signal.pause()\n'
        )
        viewer.chmod(0o700)
        code = (
            'import cache_io as c; '
            'c.download = lambda *args: b"image"; '
            'c.shutil.which = lambda name: ' + repr(str(viewer)) + '; '
            'c.run("image", ' + repr(str(self.path)) + ', 1, 100, "https://example.test", False)'
        )
        proc = subprocess.Popen([sys.executable, '-B', '-c', code],
                                cwd=Path(cache.__file__).parent,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            ready, _, _ = select.select([proc.stdout], [], [], 5)
            self.assertTrue(ready, 'Viewer did not start')
            self.assertEqual(json.loads(proc.stdout.readline()), [proc.pid, 'image'])
            proc.terminate()
            self.assertLess(proc.wait(timeout=5), 0)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
