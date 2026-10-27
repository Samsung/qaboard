# Celery runners: RabbitMQ accounts for teams (SIRC)

Teams run Celery workers on their own hosts, and `qa batch --runner=celery` sends them the runs through QA-Board's
RabbitMQ, published on `qa:5672` (`QABOARD_RABBITMQ_HOST_IP=0.0.0.0` in `deployments/sirc/production.env`).
The generic docs: [Celery integration](https://samsung.github.io/qaboard/docs/celery-integration)
(source: `website/docs/celery-integration.mdx`).

**Why accounts**: workers run the shell commands of the tasks they get. With the shared `guest:guest` account, anyone
on the network can send commands to every team's workers. A team account is a RabbitMQ *virtual host* with its own
user: its workers only get its tasks, and other accounts can't send them any.

Assuming you work on the QA-Board server:
```bash
ssh qa
cd /home/ispq/qaboard_prod
source deployments/sirc/.envrc
dc() { docker compose --env-file deployments/sirc/production.env "$@"; }
```

## Give a team an account
```bash
team=camera   # letters, digits, - and _
password=$(openssl rand -hex 16)
dc exec rabbitmq rabbitmqctl add_vhost $team
dc exec rabbitmq rabbitmqctl add_user $team $password
dc exec rabbitmq rabbitmqctl set_permissions -p $team $team ".*" ".*" ".*"
echo "pyamqp://$team:$password@qa:5672/$team"
```
Send the URL to the team (not in a ticket or a public channel), with what they change:

- In their *qaboard.yaml* (in git: the password stays in the environment, needs `qa` from this release):
  ```yaml
  runners:
    celery:
      broker_url: pyamqp://camera:${QA_CELERY_PASSWORD}@qa:5672/camera
  ```
  and `export QA_CELERY_PASSWORD=...` where they run `qa` and where their workers run.
- Or, with any `qa` version: remove `broker_url` from *qaboard.yaml*, and `export CELERY_BROKER_URL=pyamqp://...`
  in the same places.
- Then restart their workers. Runs queued with the old account stay in the old queue: let them finish first.

Change a password: `dc exec rabbitmq rabbitmqctl change_password $team <new>`. Remove a team: `dc exec rabbitmq rabbitmqctl delete_vhost $team`
(it deletes its queues) and `delete_user $team`.

## Who still uses guest
```bash
dc exec rabbitmq rabbitmqctl list_connections user vhost peer_host | sort | uniq -c
```
`guest` connections from the `qa` host's Docker network are QA-Board itself (the backend and Flower). Others are
workers or `qa` on teams' hosts: find their owners from the hosts.

## Stop guest from the network
Once only QA-Board uses `guest`:
1. Give QA-Board its own account, in `.env` (URL-safe characters):
   ```bash
   QABOARD_RABBITMQ_USER=qaboard
   QABOARD_RABBITMQ_PASSWORD=$(openssl rand -hex 16)
   ```
   ```bash
   dc exec rabbitmq rabbitmqctl add_user qaboard <password>
   dc exec rabbitmq rabbitmqctl set_permissions -p / qaboard ".*" ".*" ".*"
   # Flower reads the management API
   dc exec rabbitmq rabbitmqctl set_user_tags qaboard administrator
   ```
2. Deploy (`deployments/deploy.py deployments/sirc/production.env up`): the backend and Flower use the new account.
3. `dc exec rabbitmq rabbitmqctl delete_user guest`.

## Notes
- Flower (https://qa/flower/, for QA-Board's admins) shows the default virtual host only, not the teams'.
- AMQP isn't encrypted: passwords and tasks cross the network in clear. TLS (port 5671) needs a certificate for `qa`
  and `ssl_options` in RabbitMQ's configuration.
- The web app starts tuning batches on LSF at SIRC (`QABOARD_TUNING_RUNNER`), so the server doesn't need the teams' accounts.
