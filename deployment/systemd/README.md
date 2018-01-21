# Running the application automatically
Many Linux distributions use `systemd` as scheduler. To run the `slamvizapp` application automatically, run:

```bash
sudo cp systemd/* /etc/systemd/system/
sudo systemctl enable slamvizapp-*
```

It will
- run the application server.
- watch new commit results on the filesystem.
- clean old results and core dumps every 15min.

