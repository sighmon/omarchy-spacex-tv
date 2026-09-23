"""Bounded cache I/O anchored to verified directory descriptors (Linux)."""
import os
import secrets
import shutil
import stat
import subprocess
import sys


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


def checked_directory(fd, leaf=False):
    info = os.fstat(fd)
    uid = os.geteuid()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid):
        raise ValueError("Untrusted cache directory owner")
    # Root-owned sticky ancestors such as /tmp cannot have other users replace
    # our checked child. Never permit a shared writable cache directory itself.
    shared_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX and not leaf
    if info.st_mode & 0o022 and not shared_root:
        raise ValueError("Writable cache ancestor")
    if leaf and info.st_uid != uid:
        raise ValueError("Cache directory is not owned by this user")


def cache_parent(path):
    if not os.path.isabs(path):
        raise ValueError("Cache path must be absolute")
    parts = path.split('/')[1:]
    if not parts or any(p in ('', '.', '..') for p in parts):
        raise ValueError("Invalid cache path")
    fd = os.open('/', DIR_FLAGS)
    try:
        checked_directory(fd)
        for component in parts[:-1]:
            try:
                child = os.open(component, DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            checked_directory(fd)
        checked_directory(fd, leaf=True)
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def cached_bytes(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | FILE_FLAGS, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o022 or info.st_nlink != 1):
            raise ValueError("Untrusted cache file")
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(limit + 1)
        if not data or len(data) > limit:
            raise ValueError("Invalid cache size")
        return data
    finally:
        os.close(fd)


def download(url, seconds, limit):
    command = ['curl', '-fsSL', '--compressed', '--max-time', str(seconds),
               '--max-filesize', str(limit), '-A', 'Mozilla/5.0 Omarchy SpaceXTV/1.0',
               '--', url]
    with subprocess.Popen(command, stdout=subprocess.PIPE) as proc:
        data = proc.stdout.read(limit + 1)
        if len(data) > limit:
            proc.kill()
        status = proc.wait()
    if status or not data or len(data) > limit:
        raise ValueError("Cache download failed or exceeded limit")
    return data


def publish(parent, name, data):
    staging = '.spacex-' + secrets.token_hex(24)
    fd = os.open(staging, os.O_RDWR | os.O_CREAT | os.O_EXCL | FILE_FLAGS,
                 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as target:
            target.write(data)
            target.flush()
        os.fsync(fd)
        os.replace(staging, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise
    finally:
        try:
            os.unlink(staging, dir_fd=parent)
        except FileNotFoundError:
            pass


def run(mode, path, seconds, limit, url, fallback):
    parent, name = cache_parent(path)
    fd = None
    try:
        try:
            data = download(url, seconds, limit)
        except (OSError, ValueError):
            if mode == 'image':
                os.execvp('xdg-open', ['xdg-open', url])
                return
            if mode != 'json' or not fallback:
                raise
            data = cached_bytes(parent, name, limit)
        else:
            fd = publish(parent, name, data)
        if mode == 'json':
            sys.stdout.buffer.write(data)
        else:
            viewer = shutil.which('swayimg') or shutil.which('imv')
            if viewer:
                # The viewer receives the already-open inode, never a pathname
                # that could have changed since publication. Replace this
                # process so Quickshell still owns the viewer's lifecycle.
                os.set_inheritable(fd, True)
                os.execv(viewer, [viewer, '-f', '/proc/self/fd/' + str(fd)])
            else:
                os.execvp('xdg-open', ['xdg-open', url])
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


if __name__ == '__main__':
    try:
        mode, path, seconds, limit, url, fallback = sys.argv[1:]
        if mode not in ('json', 'image') or int(seconds) <= 0 or int(limit) <= 0:
            raise ValueError('Invalid cache arguments')
        run(mode, path, int(seconds), int(limit), url, fallback == '1')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print('SpaceX TV cache: ' + str(error), file=sys.stderr)
        sys.exit(1)
