---
id: user-management
sidebar_label: User Management
title: User Management
---
import useBaseUrl from '@docusaurus/useBaseUrl';

QA-Board supports several types of sign-in systems to allow different levels of access and user-features such as Tuning.

### sign-in types:
- LOCAL - an internal users list, created by qaboard admins.<br />
- LDAP
- SSO via SAML

To register a new LOCAL user, add an entry to the database under `users` table.<br />
Or enable http requests of the _signup()_ function at _backend/backend/api/auth.py_ , then use the curl command:
```bash
curl -d "user_name=<user_name>&password=<password>&email=<user_email>&full_name=<user_full_name>" -X POST '<qaboard_url>/api/v1/user/signup/
```
### environment variables:
The sign-in policy is set via environment variables such as `QABOARD_LOGIN_*`, `QABOARD_LDAP_*`, `QABOARD_SAML_*`, as described below:

| ENV Variable           | Default | Usage                                                |
-------------------------|-------- |------------------------------------------------------|
| `QABOARD_LOGIN_TYPE`   | _LOCAL_  | Set to `LOCAL/LDAP/SAML`                   |
| `QABOARD_LOGIN_REQUIRED`   | _false_  | Set to `true` to block anonymous users                   |
| `QABOARD_LOGIN_RESTRICTED`   | _false_  | Set to `true` to use a configuration file to allow only specific users                   |
| `QABOARD_LOGIN_RESTRICTED_YAML`   | _none_  | The path to the users configuration file                     |
| `QABOARD_LDAP_HOST`   | _none_  | Server hostname (including port)                   |
| `QABOARD_LDAP_PORT`   | _389_  | Server port, usually 389 (or 636 if SSL is used / **not supported yet!**). |
| `QABOARD_LDAP_USER_BASE`   | _none_  | Search base for users. |
| `QABOARD_LDAP_BIND_DN`     | _none_  | The Distinguished Name to bind as, this user will be used to lookup information about other users. |
| `QABOARD_LDAP_PASSWORD`    | _none_  | The password to bind with for the lookup user. |
| `QABOARD_LDAP_USER_FILTER` | _none_  | User lookup filter, the placeholder `{login}` will be replaced by the user supplied login. (e.g. `(&(objectClass=inetOrgPerson)(|(uid={login})(mail={login})))`, or `(&(objectClass=user)(|(sAMAccountName={login})))`) |
| `QABOARD_LDAP_ATTRIBUTE_EMAIL`         | _mail_  |                                            |
| `QABOARD_LDAP_ATTRIBUTE_COMMON_NAME`   | _cn_    |                                            |
| `QABOARD_SAML_DIR`   | _none_  | The path to the directory with the SAML configuration files, as in the [python-saml](https://github.com/SAML-Toolkits/python-saml) docs |
| `QABOARD_SAML_ATTRIBUTE_EMAIL`         | _none_  |                                            |
| `QABOARD_SAML_ATTRIBUTE_COMMON_NAME`         | _none_  |                                            |
| `QABOARD_SAML_ATTRIBUTE_USER_NAME`   | _none_    |                                            |
| `QABOARD_SAML_ATTRIBUTE_ID`   | _none_    |                                            |

## Accessing Content
To block **unsigned** users from viewing the content on qaboard, set the environment variable `QABOARD_LOGIN_REQUIRED=true`.
<img alt="Image viewer" src={useBaseUrl('img/login-block-unsigned-user.jpg')} />

## Restricting sign-in
To allow only specific users to sign-in, set the environment variables:
- `QABOARD_LOGIN_RESTRICTED=true`
- `QABOARD_LOGIN_RESTRICTED_YAML=path/to/users_restrict.yml`

The yaml configuration file for user authentication, supports all keys from the database table `users`.<br />
qaboard will check each key against the user that's trying to login.
once a key and value are matched, the authentication succeeded (an "OR" relationship).
Example:

```yml
# users_restrict.yml

# this yml uses 4 different keys for authentication:
#   user_name: for 'user1'/'user2'/'john.doe'.
#   email: for 'mr.nobody@samsung.com/user3@samsung.com'
#   data: ...CompId:  for any user with the CompId 'C123'/'C777'.
#   data: ...GrdName: for any user with the GrdName 'Staff/Team Leader'.
user_name:
- user1
- user2
- john.doe
email:
- mr.nobody@samsung.com
- user3@samsung.com
data:
  http://sso.company.com/2023/11/CompId:
  - C123
  - C777
  http://sso.company.com/2023/11/GrdName:
  - Staff
  - Team Leader
```
> **Note:** any update in the yaml will require a restart of the backend server.