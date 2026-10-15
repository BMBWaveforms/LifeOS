"""Provision configured test accounts without replacing existing users or data."""
import hashlib
import json
import os
import secrets
import tempfile

TEST_ACCOUNTS = tuple('test' + str(number) for number in range(1, 11))


def password_hash(password):
    salt = secrets.token_hex(16)
    return {'salt': salt, 'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 260000).hex()}


def matches(password, record):
    if not record:
        return False
    candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), record['salt'].encode(), 260000).hex()
    return secrets.compare_digest(candidate, record['hash'])


def private_json(path, data):
    descriptor, filename = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.', suffix='.tmp')
    try:
        with os.fdopen(descriptor, 'w') as file:
            json.dump(data, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(filename, path)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def initialize_accounts(store, test_password=None):
    if test_password is not None and not isinstance(test_password, str):
        raise ValueError('测试密码必须为字符串。')
    profiles = dict(store.profiles)
    if test_password:
        for number, username in enumerate(TEST_ACCOUNTS, 1):
            if username not in profiles:
                profiles[username] = {'name': '测试用户 ' + str(number), 'token': secrets.token_urlsafe(32)}
    if profiles != store.profiles:
        private_json(store.directory / 'profiles.json', profiles)
        store.profiles = profiles
        with store.db() as database:
            for username in profiles:
                database.execute('INSERT OR IGNORE INTO profiles(id) VALUES (?)', (username,))

    auth_path, login_path = store.directory / 'auth.json', store.directory / 'login.json'
    auth = json.loads(auth_path.read_text()) if auth_path.exists() else {}
    credentials = json.loads(login_path.read_text()) if login_path.exists() else {}
    changed = False
    for username, profile in profiles.items():
        configured_test = bool(test_password) and username in TEST_ACCOUNTS
        if username not in auth or (configured_test and not matches(test_password, auth[username])):
            password = test_password if configured_test else secrets.token_urlsafe(16)
            auth[username] = password_hash(password)
            credentials[username] = {'name': profile['name'], 'password': password}
            changed = True
    if changed:
        private_json(login_path, credentials)
        private_json(auth_path, auth)
    return auth
