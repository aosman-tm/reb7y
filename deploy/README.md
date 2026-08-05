# Deploying reb7y

The app runs on an InterServer VPS at **162.35.184.237**, served at
**https://162-35-184-237.sslip.io**.

## How a deploy happens

Push to `main`. That is the whole process.

The server checks GitHub every 60 seconds and deploys anything new by itself,
so a change is live roughly a minute after you push. Nothing needs to be run by
hand and no passwords or keys are stored in GitHub.

```
git push origin main   ->   server notices within 60s   ->   build   ->   restart
```

Each deploy installs dependencies, applies database migrations, rebuilds the
app, restarts it, and waits until it answers on `/healthz`.

### Optional: make it instant

Adding a repository secret named `VPS_SSH_KEY` (the private half of the deploy
key) makes GitHub Actions push the deploy immediately instead of waiting for the
next 60-second check. Without it the workflow simply skips; the timer still
deploys. Both paths take the same lock, so they cannot run at the same time.

## Checking on it

Run these as `root` on the server (`ssh root@162.35.184.237`):

```bash
systemctl status reb7y              # is the app running?
journalctl -u reb7y -f              # live application log
journalctl -u reb7y-autodeploy -n 50  # what the last auto-deploy did
systemctl list-timers reb7y-autodeploy.timer   # when it next checks
```

Deploy by hand, without waiting for the timer:

```bash
sudo -u deploy /srv/reb7y/run-deploy.sh
```

## Where things live

| What | Where |
|---|---|
| Application code | `/srv/reb7y/app` (git checkout, owned by `deploy`) |
| Secrets and settings | `/srv/reb7y/.env` (readable only by `deploy`) |
| Database | `/var/lib/reb7y/prod.sqlite` |
| Deploy entrypoint | `/srv/reb7y/run-deploy.sh` |
| Web server config | `/etc/caddy/Caddyfile` |

The database sits **outside** the code directory on purpose: deploys reset the
checkout to match GitHub, so anything stored inside it would be destroyed.

### Backing up the database

```bash
sqlite3 /var/lib/reb7y/prod.sqlite ".backup '/root/reb7y-$(date +%F).sqlite'"
```

## Moving to a real domain

`162-35-184-237.sslip.io` is a free domain that points at the server's IP. To
switch to your own domain, point its DNS A record at `162.35.184.237`, then:

1. Replace the domain in `deploy/Caddyfile` and in `shopify.app.toml`
   (`application_url` and all three `redirect_urls`), and push.
2. On the server, update `SHOPIFY_APP_URL` in `/srv/reb7y/.env`, then
   `systemctl restart reb7y caddy`.
3. Update the URLs in the Shopify Partner dashboard to match.

Caddy requests the HTTPS certificate automatically; there is nothing to buy or
renew.

## The server was not a blank Ubuntu box

InterServer's activation email said Ubuntu; the machine actually runs
**AlmaLinux 9** and shipped with a **DirectAdmin** hosting stack (Apache on
ports 80/443, MySQL, mail, DNS, FTP) that was installed but unused. Those
services are stopped and disabled so the app can use the web ports and the RAM.

To bring any of them back:

```bash
systemctl enable --now httpd     # or directadmin, exim, mysqld, ...
mv /etc/cron.d/directadmin_cron.disabled /etc/cron.d/directadmin_cron
```

Note that Apache and Caddy both want ports 80 and 443, so they cannot run at the
same time.

Server provisioning is scripted in [`setup-server.sh`](setup-server.sh); it is
safe to re-run.
