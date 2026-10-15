Github-CI: [![Build Status][build_status]][build_link]

[build_status]: ./../../actions/workflows/build.yml/badge.svg
[build_link]: ./../../actions/workflows/build.yml

# NanoVer Web

An MVP of NanoVer for the browser and WebXR.

## Developer setup

### Install (Windows)

Install [node.js](https://nodejs.org/), [git](https://git-scm.com/), [Visual Studio Code](https://code.visualstudio.com/).

```PowerShell
winget install -e --id OpenJS.NodeJS
winget install -e --id Git.Git
winget install -e --id Microsoft.VisualStudioCode
```

Clone this repo and install its dependencies:

```PowerShell
git clone https://github.com/IRL2/nanover-web.git
cd nanover-web
npm install
```

### Developing

Run a live server that opens a new browser tab and refreshes when you edit the code:

```bash
npm run dev
```

Build the standalone web package:

```bash
npm run build
```

Preview the standalone web package:
```bash
npm run preview
```

### WebXR and headset

For security, WebXR requires that the page be served over HTTPS, so you will need to configure the Live Server extension to use an SSL certificate.

To do so, install [OpenSSL](https://slproweb.com/products/Win32OpenSSL.html#downloads), and generate a private key and certificate:

* Either choose "nanover" as the passphrase or update it later in [the vite config](./vite.config.js)
* Skip all data input except `common name` which should be `localhost`

```
openssl genrsa -aes256 -out localhost.key 2048
openssl req -days 3650 -new -newkey rsa:2048 -key localhost.key -x509 -out localhost.pem
```

### NanoVer server tests

This won't work in Firefox because it disallows connecting to self-signed websockets.

Run a NanoVer python server with nanover-server, requesting automatic ssl, and the cloud discovery address:
```bash
nanover-server --omm tutorials/ase/openmm_files/17-ala.xml --ssl-auto --cloud-discovery irl-discovery.onrender.com
```

## Serving NanoVer to the WebXR client from Python/Jupyter notebook

Create a runner from the WebXR constructor, which handles SSL self-signing automatically:

```python
imd_runner = OmniRunner.with_webxr_server(simulation, name="webxr-nanover-server")
imd_runner.load(0)
```

The server also hosts a small landing page. Opening this page once lets the device trust the self-signed certificate, otherwise wss connections might not work (won't work in Firefox anyway). This step is necessary for the Meta Quest Browser:

```python
from nanover.utilities.network import get_local_ip

services = imd_runner.app_server.service_hub.properties["services"]
print(f"Local:  https://localhost:{services['https']}")
print(f"Network:  https://{get_local_ip()}:{services['https']}")
```

Advertise on cloud discovery:

```python
imd_runner.advertise_on_web_discovery(endpoint="irl-discovery.onrender.com")
```
