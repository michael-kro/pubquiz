# HTTPS on port 443 with your own name

The quiz itself speaks plain HTTP on port 3000. For a name like `https://quiz.internal` on port 443 with a certificate, a small reverse proxy ([Caddy](https://caddyserver.com)) sits in front. It is already set up in `compose.yaml` as an optional service.

Teams don't need HTTPS for the quiz to work. It removes the "Not secure" label and stops anyone on the Wi-Fi reading the host key off the network.

## Try it on your laptop

1. **Pick a name and point it at your laptop.** `quiz.internal` is a good private name (ICANN reserved `.internal` for private use). Add it to your hosts file, using your laptop's address on the Wi-Fi (or `127.0.0.1` to use it on this laptop only):
   - Mac/Linux: `sudo sh -c 'echo "192.168.0.144 quiz.internal" >> /etc/hosts'`
   - Windows (Notepad as administrator): add the same line to `C:\Windows\System32\drivers\etc\hosts`
2. **Start the quiz and the proxy:**
   ```sh
   docker compose --profile https up -d
   ```
   To use a different name, set it first: `QUIZ_DOMAIN=quiz.night docker compose --profile https up -d`. Ports 80 and 443 must be free on the laptop.
3. **Open `https://quiz.internal`.** Your browser will say the certificate isn't trusted, because Caddy made its own certificate authority. To make the padlock appear on this laptop, trust that authority once:
   ```sh
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt
   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/caddy-root.crt   # Mac
   ```
   (The file goes to `/tmp`, not this folder, so it can't be committed by accident. It is only the public certificate, not a secret.)
   (On Windows, double-click the file and install it into **Trusted Root Certification Authorities**. On Linux, add it to your system's certificate store.)

Phones and the TV won't trust that authority, and a hosts-file entry only works on the computer you edited. For them to use the name you need DNS on the router (below), and for a padlock without warnings on their phones you need a real domain (below).

## For the venue

- **DNS on the router.** Add a record that points your name at the laptop's address, in the router's DNS settings (on a GL.iNet or OpenWrt router: static DNS / hostname, or dnsmasq `address=/quiz.internal/192.168.8.x`). Give the laptop a fixed address on that router so the record stays right.
- **Only then** tell the quiz to use the name in the QR code: set `PUBQUIZ_PUBLIC_URL: "https://quiz.internal"` in `compose.yaml` (or start the program with `--public-url https://quiz.internal`). Before the router has the record, phones can't find the name and joining would fail, so leave it empty until then.
- **A padlock on guests' phones** needs a real domain you own, for example `quiz.yourdomain.com`, with its A record pointing at the laptop's address on the venue Wi-Fi. In `docker/Caddyfile`, delete the `tls internal` line and Caddy fetches a real Let's Encrypt certificate itself. Because the address is a private one, Let's Encrypt can't reach it to check, so use the DNS challenge: build Caddy with your DNS provider's plugin and add `tls { dns <provider> {env.API_TOKEN} }`. Typing the full `https://` address, or scanning the QR code, avoids the browser treating it as a search.
- **Keep the host console private.** The quiz still answers on port 3000 over HTTP. Start it with `--host-local-only` so the host screen only works on the laptop itself (open `http://localhost:3000/host` there). Teams use the HTTPS address.

## What was checked

On a Mac with Docker (Colima): Caddy came up with `quiz.internal`, served `healthz` over HTTPS with a certificate from "Caddy Local Authority", redirected HTTP to HTTPS, and the host screen and a team's phone worked over `wss://` through the proxy (a team joined and received a question). Not tried: a real domain with a Let's Encrypt certificate, Windows, and real phones.
