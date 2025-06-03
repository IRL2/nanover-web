/**
 * Create an html element with the given attributes and children.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tagName 
 * @param {*} attributes 
 * @param  {...(Node | string)} children 
 * @returns {HTMLElementTagNameMap[K]}
 */
export function html(tagName, attributes = {}, ...children) {
    const element = /** @type {HTMLElementTagNameMap[K]} */ (document.createElement(tagName)); 
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    children.forEach((child) => element.append(child));
    return element;
}

/**
 * Open the browser file picker, optionally restricted to files of a given file
 * type pattern and optionally accepting multiple files. 
 * @param {string} accept 
 * @param {boolean} multiple 
 * @returns {Promise<File[]>}
 */
export async function pickFiles(accept = "*", multiple = false) {
    return new Promise((resolve) => {
        const fileInput = html("input", { type: "file", accept, multiple, style: "visibility: collapse" });
        
        document.body.append(fileInput);
        function done(files) {
            fileInput.remove();
            resolve(files);
        } 

        fileInput.addEventListener("change", () => done(Array.from(fileInput.files)));
        fileInput.addEventListener("cancel", () => done([]));
        fileInput.click();
    });
}

/**
 * Read plain text from a file.
 * @param {File} file 
 * @return {Promise<string>}
 */
export async function textFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve(/** @type {string} */ (reader.result));
        reader.readAsText(file); 
    });
}
