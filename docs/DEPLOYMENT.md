# Caddy deployment

The deployed Web UI is **https://muse.20070809.xyz**. It serves the production
files through the system Caddy service and uses the same `admin` credentials
as the existing application subdomains. No Vite process is required.

## Current server layout

| Path | Purpose |
| --- | --- |
| `/home/ubuntu/muse` | Repository and build workspace |
| `/srv/muse/releases/<UTC timestamp>/` | Versioned web releases |
| `/srv/muse/current` | Symlink to the active release |
| `/etc/caddy/muse.caddy` | Muse site configuration |
| `/etc/caddy/Caddyfile` | Main configuration; imports the Muse site |

Each release contains `index.html`, `muse_core.wasm`, and `assets/`. CLI output
is not copied to the web release. Caddy needs read permission on these files
and traversal permission on their parent directories.

## Site configuration

The active site follows this structure. Replace the placeholder with the
existing password hash when configuring another server; do not use it literally.

```caddyfile
muse.20070809.xyz {
    encode zstd gzip
    basic_auth {
        admin <existing-bcrypt-password-hash>
    }
    root * /srv/muse/current
    file_server
}
```

The main `/etc/caddy/Caddyfile` includes:

```caddyfile
import /etc/caddy/muse.caddy
```

The hostname currently resolves through Cloudflare. For another server, configure
DNS to point to that origin and make ports 80 and 443 reachable. Caddy manages
the HTTPS certificate automatically. Keep the real authentication hash in the
server configuration, outside this repository.

See the official Caddy documentation for [static file serving](https://caddyserver.com/docs/caddyfile/directives/file_server)
and [basic authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth).

## Publish an update

Run these commands on the deployment server from the repository. Start from the
intended checkout and finish validation before switching the active release.

```sh
cd /home/ubuntu/muse
npm ci
# One-time browser setup, if Chromium is not installed:
npx playwright install --with-deps chromium
npm run verify
```

`verify` builds the production site after its tests. Copy the web files into a
new release and switch the symlink atomically:

```sh
muse_release_tag=$(date -u +%Y%m%dT%H%M%SZ)
muse_release_dir="/srv/muse/releases/$muse_release_tag"
sudo install -d -m 755 "$muse_release_dir/assets"
sudo cp dist/index.html dist/muse_core.wasm "$muse_release_dir/"
sudo cp -r dist/assets/. "$muse_release_dir/assets/"
sudo chmod -R a+rX "$muse_release_dir"
sudo ln -s "$muse_release_dir" /srv/muse/current.next
sudo mv -Tf /srv/muse/current.next /srv/muse/current
```

A files-only update takes effect immediately and needs no Caddy reload.
Refresh the browser after deployment so it loads the new HTML and assets.
Edited drafts remain in the browser's local storage. An untouched old default
is migrated to Canon in D; other drafts can switch through the example menu.

If the Caddy configuration changes, back up the existing files, validate, and
reload only after validation succeeds:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

## Verify the deployment

```sh
curl -I https://muse.20070809.xyz/
# Prompts for the existing admin password; do not put it in shell history:
curl --user admin -I https://muse.20070809.xyz/
```

An unauthenticated request should return **401** with a login challenge; an
authenticated request should return **200**. Open the site, sign in, select
**Canon in D**, and click **Run** to check playback. Browsers require a user
action before starting audio.

To inspect origin HTTPS without Cloudflare:

```sh
curl --resolve muse.20070809.xyz:443:127.0.0.1 -I https://muse.20070809.xyz/
sudo journalctl -u caddy --since '10 minutes ago' --no-pager
```

A Cloudflare **525** response indicates failure of the HTTPS handshake to the
origin; check the Caddy service and certificate issuance logs. A **401** is the
expected login challenge, not a failed deployment.

## Roll back

Keep older release directories until the new version has been checked. Set the
previous release name to an existing directory listed under `/srv/muse/releases`:

```sh
ls /srv/muse/releases
muse_previous_tag=20260926T122159Z  # replace with the release to restore
sudo test -f "/srv/muse/releases/$muse_previous_tag/index.html"
sudo ln -s "/srv/muse/releases/$muse_previous_tag" /srv/muse/current.next
sudo mv -Tf /srv/muse/current.next /srv/muse/current
```

Refresh the browser and repeat the HTTPS and playback checks. For a
configuration rollback, restore its backup, validate it, and reload Caddy.
