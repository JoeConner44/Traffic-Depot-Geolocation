# Deploy to a Google Cloud VM

Runs the app on a small always-free-tier Compute Engine VM (`e2-micro`) with automatic HTTPS (Caddy), a systemd
service (restarts itself), and a nightly sync (cron).

**Cost:** the `e2-micro` VM and 30 GB standard disk are in Google's always-free tier in `us-west1`, `us-central1` and
`us-east1`. Google charges a few dollars a month for the VM's external IPv4 address, which the free tier does not cover.
Check current pricing on Google's site and add a billing budget alert.

## 1. Create the VM
1. Google Cloud Console → project **Traffic Depot Map** → **Compute Engine → VM instances** (enable the API if asked).
2. **Create instance**:
   - Name `td-map`, region `us-central1` (or `us-east1` / `us-west1`)
   - Machine type: **e2-micro**
   - Boot disk: **Debian 12**, **Standard persistent disk**, **30 GB**
   - Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**
   - **Advanced → Networking → Network interfaces → External IPv4 address → Reserve static external IP address** (so the
     address never changes)
3. **Create**. Note the external IP (for example `34.23.45.67`).

## 2. Pick the web address
- **With your own domain:** add an `A` record, for example `map.trafficdepot.com`, pointing to the IP.
- **Without one:** use the IP with dashes plus `.sslip.io`, for example `34-23-45-67.sslip.io`. It resolves to your IP
  and gets a real HTTPS certificate.

Use this name as `<hostname>` below.

## 3. Connect and download the code
In the VM list click **SSH** (a browser terminal opens). Run:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo mkdir -p /opt/traffic-depot && sudo chown "$USER": /opt/traffic-depot
ssh-keygen -t ed25519 -N "" -f ~/.ssh/td_deploy -C "td-map-vm"
cat >> ~/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/td_deploy
  StrictHostKeyChecking accept-new
CFG
chmod 600 ~/.ssh/config
cat ~/.ssh/td_deploy.pub
```

Copy the line that starts with `ssh-ed25519`. On GitHub: repo **Traffic-Depot-Geolocation → Settings → Deploy keys → Add
deploy key**, paste it, leave **Allow write access unchecked**, save. Then:

```bash
git clone git@github.com:JoeConner44/Traffic-Depot-Geolocation.git /opt/traffic-depot
cd /opt/traffic-depot
```

## 4. Create the `.env`
```bash
cp deploy/env.production.example .env
openssl rand -hex 32        # run twice: one value for SESSION_SECRET, one to use as a strong APP_PASSWORD (or pick your own)
nano .env                   # fill in the values; save with Ctrl+O, Enter, exit with Ctrl+X
```
Keep `NODE_ENV=production`, `TRUST_PROXY=1`, `HOST=127.0.0.1` and the `DB_PATH` as given.

## 5. Run the setup script
```bash
cd /opt/traffic-depot
sudo bash deploy/setup.sh <hostname>
```
It installs Node 22 and Caddy, creates the service, enables HTTPS and schedules the nightly sync. It can be re-run safely.
Check it: `systemctl status td-map --no-pager`, then open `https://<hostname>` and sign in.

## 6. Load the data
**Option A (recommended): copy your existing database** so already-geocoded addresses aren't paid for again.
On your Windows computer, with the app stopped, in the project folder:
```
node -e "const D=require('better-sqlite3');const d=new D('data/traffic-depot.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"
```
In the VM's browser SSH window click the **gear icon → Upload file** and choose `data\traffic-depot.db`. Then:
```bash
sudo systemctl stop td-map
sudo mv ~/traffic-depot.db /var/lib/traffic-depot/traffic-depot.db
sudo chown tdmap:tdmap /var/lib/traffic-depot/traffic-depot.db
sudo systemctl start td-map
```

**Option B:** run a fresh sync on the server (costs geocoding lookups again):
```bash
sudo -u tdmap bash -c 'cd /opt/traffic-depot && node src/sync.js'
```

## 7. Lock down the Google key
Google Cloud → **APIs & Services → Credentials →** your key → **Application restrictions → IP addresses** → add the
VM's external IP. Keep the API restriction on Geocoding API. Save.

## Everyday operations
| Task | Command (in the VM) |
|---|---|
| Update to the latest code | `cd /opt/traffic-depot && git pull && npm ci --omit=dev && sudo systemctl restart td-map` |
| App logs | `sudo journalctl -u td-map -n 50 --no-pager` |
| Web server / HTTPS logs | `sudo journalctl -u caddy -n 50 --no-pager` |
| Sync log | `tail -n 50 /var/log/td-sync.log` |
| Run a sync now | `sudo -u tdmap bash -c 'cd /opt/traffic-depot && node src/sync.js'` |
| Change a setting | `nano /opt/traffic-depot/.env` then `sudo systemctl restart td-map` |
| Change the password | edit `APP_PASSWORD` in `.env`, then restart |

The sync runs nightly at 09:15 UTC (5:15am US Eastern). Edit `/etc/cron.d/td-sync` to change it.

## Troubleshooting
- **Certificate or HTTPS errors:** ports 80 and 443 must be open (the two firewall tick boxes in step 1), and the
  hostname must point at the VM's IP. Check `sudo journalctl -u caddy -n 50`.
- **`npm ci` fails or the VM runs out of memory:** the setup script adds swap; re-run it.
- **Login works but the page loops back to login:** `TRUST_PROXY=1` and `NODE_ENV=production` must both be set, and you
  must use the `https://` address.
- **Backups:** everything is rebuilt from HubSpot by a sync; the database file also holds the geocode cache, so copy
  `/var/lib/traffic-depot/traffic-depot.db` somewhere safe if you want to avoid paying for lookups again.
