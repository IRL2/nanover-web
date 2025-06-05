# NanoVer Web

A proof of concept or prototype of NanoVer for the browser and WebXR.

## Developer setup

### Desktop browser

 * Install Visual Studio Code IDE: https://code.visualstudio.com/
 * Install Live Server extension: https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer
 * Clone this git repository and open the root folder in VS Code
 * Click "Go Live" in the bottom right corner, and begin developing

### WebXR and headset

For security, WebXR requires that the page be served over HTTPS, so you will need to configure the Live Server extension to use an SSL certificate.

To do so, follow these instructions, noting that on windows you should prefix openssl commands on windows with `winpty` (e.g `winpty openssl genrsa -aes256 -out localhost.key 2048`): https://graceydev.hashnode.dev/enabling-https-for-live-server-visual-studio-code-extension
