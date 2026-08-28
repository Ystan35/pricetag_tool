# HTTPS setup (optional — no longer required)

**Update:** the Price Checker app no longer uses the phone's camera (OTG/
Bluetooth scanners are used instead), so this HTTPS setup is now optional.
Plain HTTP works fine for barcode lookups and flag submissions since
`fetch()` doesn't require a secure context the way `getUserMedia()` did.
Skip this whole file unless you have another reason to want HTTPS.

Phone browsers only allow camera access — used for both barcode scanning
and QR pairing — on a "secure context": HTTPS, or `localhost`. A plain
`http://192.168.x.x` LAN address doesn't count, even though the traffic
never leaves your network. This sets up a self-signed certificate so both
servers run over HTTPS instead.

## 1. Generate the certificate (once, on the pricetag_tool computer)

```
cd pricetag_tool
pip install -r requirements.txt
python make_cert.py
```

This writes `cert.pem` and `key.pem` into the `pricetag_tool` folder,
covering `localhost`, `127.0.0.1`, and every private network address this
computer currently has (a machine with a VPN, Docker Desktop, or a virtual
adapter installed can have more than one — the script lists them all when
it finishes).

**Re-run this if the computer's LAN IP ever changes** (new router, DHCP
lease expiry, etc.) — old files are overwritten automatically.

## 2. Copy the cert into the PWA folder

If the `price-checker-pwa` folder sits next to `pricetag_tool` (the normal
layout), `make_cert.py` copies `cert.pem`/`key.pem` there for you
automatically — you'll see it confirm this when it finishes, and you can
skip straight to step 3.

Otherwise, copy them there yourself:

```
copy cert.pem key.pem ..\price-checker-pwa\
```

(or drag-and-drop both files if you're not using the command line)

## 3. Start both servers

- **pricetag_tool**: just launch it normally (`Start Price Tag Tool.bat`
  or `python gui.py`). It auto-detects `cert.pem`/`key.pem` next to
  `flag_server.py` and switches to HTTPS on its own — nothing else to
  configure. The **📱 Pair Phone** QR code will automatically show an
  `https://` address once it detects the cert.

- **price-checker-pwa**: instead of `python -m http.server`, run:
  ```
  cd price-checker-pwa
  python serve_https.py
  ```

## 4. First-time trust on each phone

Because this is a self-signed certificate (not from a public certificate
authority), the phone's browser will show a warning the first time it
visits either HTTPS address. Two ways to handle it:

**Option A — quick, per-phone warning (fine for a few staff phones)**
Visit `https://<computer-LAN-IP>:8080` on the phone, tap **Advanced** →
**Proceed** (wording varies by browser). Do the same once for
`https://<computer-LAN-IP>:8765` (the Pair Phone QR code handles this
automatically the first time it's scanned, but Test Connection may still
show a certificate error until the phone has accepted it directly). After
that, the browser remembers your choice for that page.

**Option B — install as a trusted certificate (no warnings, better for
rolling out to many phones)**
1. Copy `cert.pem` onto the phone (email it to yourself, AirDrop-equivalent,
   or host it briefly for download).
2. On Android: **Settings → Security → Encryption & credentials → Install
   a certificate → CA certificate**, then select the file. Android will
   show a warning about installing a CA cert — that's expected since
   you're installing a certificate you generated yourself, not a
   public one.
3. Once installed, both HTTPS addresses load with no warnings, on that
   phone, indefinitely.

## Phone can't connect at all (works fine on this computer)

If the desktop app and `https://localhost:...` both work, but a phone on the
same Wi-Fi gets nothing (spinner, "can't reach this page", or a timeout --
not a certificate warning, which is a different, expected thing), the
request usually isn't reaching this computer at all. In order of how often
each one turns out to be the cause:

1. **Windows Firewall.** The first time these servers bind to a network
   port, Windows may ask whether to allow it through the firewall -- if that
   prompt was missed, dismissed, or blocked by an IT policy, the port stays
   closed to other devices even though everything runs fine locally. Run
   `Allow Firewall Access.bat` (in the `pricetag_tool` folder) **as
   Administrator** to add the needed allow rules, then try the phone again.

2. **Wrong address.** A computer with a VPN client, Docker Desktop, Hyper-V,
   or any virtual network adapter installed can have more than one network
   address, and the one shown in the Pair Phone window / QR code isn't
   always the one a phone can actually reach. Both `make_cert.py` and the
   Pair Phone window now list every address this machine has -- if the
   first one doesn't work from the phone, try the others.

3. **AP / client isolation.** Some routers (especially guest Wi-Fi or office
   networks) deliberately block devices on the same Wi-Fi from reaching each
   other. If a phone hotspot works but the real Wi-Fi doesn't, this is
   likely it -- ask whoever manages the router, or use a phone hotspot as a
   short-term workaround.

Run `python diagnose_network.py` (in the `pricetag_tool` folder) to check
all three automatically -- it lists this machine's addresses, confirms the
ports are actually free to use, and checks Windows Firewall's state and
rules. There's also a **"Phone can't connect?"** button in the Pair Phone
window that opens the same diagnostics.

## Reverting to HTTP

If you'd rather not deal with certificates (e.g. only using Bluetooth/OTG
scanners and manual entry, never the camera), just delete `cert.pem` and
`key.pem` from the `pricetag_tool` folder and go back to
`python -m http.server` for the PWA. Everything falls back to plain HTTP
automatically — camera buttons just won't work on phones in that case.
