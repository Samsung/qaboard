# Deployment information
> what follows are only notes
>
> it's best to read the *Dockerfile*

- **Docker entrypoint:** *deployment/init.sh*
- **ssh/id_rsa**: passphrase-protected ssh key used to update our `psp_swip` mirror and send jobs to our cluster.
- **DLP-TRITON.crt**: samsung's MITM certificate used for SSL connections.

## Serving via uwsgi-nginx
```bash
sudo apt-get install nginx
# You may want to copy only sites-available/slamvizapp and mime.types...
cp -r deployment/nginx /etc/nginx

pip install uwsgi
uwsgi --ini deployment/slamvizapp.ini
```

# Running the application automatically as a linux service
Many Linux distributions use `systemd` as scheduler. To run the `slamvizapp` application automatically, run:

```bash
sudo cp systemd/* /etc/systemd/system/
sudo systemctl enable slamvizapp-*
```

It will
- run the application server.
- watch new commit results on the filesystem.
- clean old results and core dumps every 15min.
