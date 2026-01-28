import GUI from 'lil-gui';
import jsQR from 'jsqr';

export function setupQRScanner(gui: GUI, onFileLoaded: (arrayBuffer: ArrayBuffer, filename: string) => void) {
    const qrFolder = gui.addFolder("QR Code Scanner");
    const qrState = {
        enabled: false,
        lastResult: "No QR detected yet",
    };

    let qrVideo: HTMLVideoElement | null = null;
    let qrCanvas: HTMLCanvasElement | null = null;
    let qrContext: CanvasRenderingContext2D | null = null;
    let qrOverlay: HTMLDivElement | null = null;
    let qrStream: MediaStream | null = null;
    let isScanningQR = false;
    let detectedUrl = "";

    qrFolder.add(qrState, "lastResult").name("Result").listen();

    const loadScannedFile = async () => {
        if (!detectedUrl) return;
        console.log("Processing scanned URL:", detectedUrl);

        try {
            loadButtonController.name("Downloading...");

            // github url parcer to avoid cors issues
            let fetchUrl = detectedUrl;
            const githubRegex = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/;
            const match = detectedUrl.match(githubRegex);

            if (match) {
                fetchUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
                console.log("Converted GitHub URL to:", fetchUrl);
            }

            let arrayBuffer: ArrayBuffer | null = null;

            try {
                const response = await fetch(fetchUrl);
                if (!response.ok) throw new Error("Status: " + response.status);
                arrayBuffer = await response.arrayBuffer();
            } catch (err) {
                console.warn("Direct fetch failed", err);
            }

            if (!arrayBuffer) throw new Error("Empty response");

            const filename = detectedUrl.split('/').pop()?.split('?')[0] || "scanned_file.traj";

            onFileLoaded(arrayBuffer, filename);

            loadButtonController.name("Loaded!");
            setTimeout(() => loadButtonController.name("Load Scanned URL"), 2000);

            qrState.enabled = false;
            enableController.updateDisplay();
            stopQRScanner();

        } catch (err) {
            console.error("Failed to load file from QR:", err);
            loadButtonController.name("Failed (See Console)");
            setTimeout(() => loadButtonController.name("Load Scanned URL"), 3000);
        }
    };

    const loadButtonController = qrFolder.add({ load: loadScannedFile }, "load").name("Load Scanned URL").disable();
    const enableController = qrFolder.add(qrState, "enabled").name("Enable Scanner").onChange((enabled: boolean) => {
        if (enabled) {
            startQRScanner();
        } else {
            stopQRScanner();
        }
    });

    function drawQRLine(begin: { x: number, y: number }, end: { x: number, y: number }, color: string) {
        if (!qrContext) return;
        qrContext.beginPath();
        qrContext.moveTo(begin.x, begin.y);
        qrContext.lineTo(end.x, end.y);
        qrContext.lineWidth = 4;
        qrContext.strokeStyle = color;
        qrContext.stroke();
    }

    async function startQRScanner() {
        // simple overlay setup
        if (!qrOverlay) {
            qrOverlay = document.createElement("div");
            qrOverlay.style.position = "fixed";
            qrOverlay.style.bottom = "20px";
            qrOverlay.style.right = "20px";
            qrOverlay.style.width = "320px";
            qrOverlay.style.height = "240px";
            qrOverlay.style.backgroundColor = "black";
            qrOverlay.style.border = "2px solid white";
            qrOverlay.style.zIndex = "1000";
            qrOverlay.style.borderRadius = "8px";
            qrOverlay.style.overflow = "hidden";
            document.body.appendChild(qrOverlay);
        } else {
            qrOverlay.style.display = "block";
        }

        if (!qrVideo) {
            qrVideo = document.createElement("video");
            qrVideo.style.width = "100%";
            qrVideo.style.height = "100%";
            qrVideo.style.objectFit = "cover";
            qrOverlay.appendChild(qrVideo);
        }

        if (!qrCanvas) {
            qrCanvas = document.createElement("canvas");
            qrCanvas.style.position = "absolute";
            qrCanvas.style.top = "0";
            qrCanvas.style.left = "0";
            qrCanvas.style.width = "100%";
            qrCanvas.style.height = "100%";
            qrOverlay.appendChild(qrCanvas);
            qrContext = qrCanvas.getContext("2d");
        }

        try {
            qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
            if (qrVideo) {
                qrVideo.srcObject = qrStream;
                qrVideo.setAttribute("playsinline", "true");
                qrVideo.play();
                isScanningQR = true;
                requestAnimationFrame(qrTick);
            }
        } catch (err) {
            console.error("Error accessing camera for QR scan:", err);
            qrState.enabled = false;
            qrState.lastResult = "Camera Error";
            enableController.updateDisplay();
        }
    }

    function qrTick() {
        if (!isScanningQR || !qrVideo || !qrCanvas || !qrContext) return;

        if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
            qrCanvas.height = qrVideo.videoHeight;
            qrCanvas.width = qrVideo.videoWidth;

            qrContext.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);

            const imageData = qrContext.getImageData(0, 0, qrCanvas.width, qrCanvas.height);


            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "dontInvert",
            });

            if (code) {

                drawQRLine(code.location.topLeftCorner, code.location.topRightCorner, "#FF3B58");
                drawQRLine(code.location.topRightCorner, code.location.bottomRightCorner, "#FF3B58");
                drawQRLine(code.location.bottomRightCorner, code.location.bottomLeftCorner, "#FF3B58");
                drawQRLine(code.location.bottomLeftCorner, code.location.topLeftCorner, "#FF3B58");


                if (qrState.lastResult !== code.data) {
                    qrState.lastResult = code.data;


                    if (code.data.startsWith("http://") || code.data.startsWith("https://")) {
                        detectedUrl = code.data;
                        loadButtonController.enable();
                    } else {
                        detectedUrl = "";
                        loadButtonController.disable();
                    }
                }
            }
        }

        requestAnimationFrame(qrTick);
    }

    function stopQRScanner() {
        isScanningQR = false;
        if (qrStream) {
            qrStream.getTracks().forEach(track => track.stop());
            qrStream = null;
        }
        if (qrOverlay) {
            qrOverlay.style.display = "none";
        }
        loadButtonController.disable();
    }
}