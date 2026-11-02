"""Files under /s/ follow auth.require_sign_in: nginx asks /api/v1/files/authorize before serving them"""
import os


def test_files_need_a_sign_in_when_the_server_requires_it(client, logged_in, monkeypatch):
  path = os.environ['QABOARD_STORAGE_ROOTS'] + '/some/file.txt'
  assert client.get(f'/api/v1/files/authorize?path={path}').status_code == 204
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', 'true')
  response = client.get(f'/api/v1/files/authorize?path={path}')
  assert response.status_code == 401 and response.get_json()["reason"] == "login"
  assert client.get('/s/').status_code == 401
  assert logged_in('alice').get(f'/api/v1/files/authorize?path={path}').status_code == 204
