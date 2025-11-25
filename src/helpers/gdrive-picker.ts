declare const gapi: any;
declare const google: any;

const SCOPES = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY;
const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID;

export class GDrivePicker {
  private tokenClient: any;
  private accessToken: string | null = null;
  private pickerInited = false;
  private gisInited = false;
  private onAuthCallback?: (isAuthorized: boolean) => void;
  private onFileSelectedCallback?: (fileData: any) => void;

  constructor() {
    this.loadAPIs();
  }

  private loadAPIs() {

    const gapiScript = document.createElement('script');
    gapiScript.src = 'https://apis.google.com/js/api.js';
    gapiScript.async = true;
    gapiScript.defer = true;
    gapiScript.onload = () => this.gapiLoaded();
    document.head.appendChild(gapiScript);

    const gsiScript = document.createElement('script');
    gsiScript.src = 'https://accounts.google.com/gsi/client';
    gsiScript.async = true;
    gsiScript.defer = true;
    gsiScript.onload = () => this.gisLoaded();
    document.head.appendChild(gsiScript);
  }

  private gapiLoaded() {
    gapi.load('client:picker', () => this.initializePicker());
  }

  private async initializePicker() {
    await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest');
    this.pickerInited = true;
    this.maybeEnableAuth();
  }

  private gisLoaded() {
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: '',
    });
    this.gisInited = true;
    this.maybeEnableAuth();
  }

  private maybeEnableAuth() {
    if (this.pickerInited && this.gisInited && this.onAuthCallback) {
      this.onAuthCallback(true);
    }
  }

  public onAuthReady(callback: (isAuthorized: boolean) => void) {
    this.onAuthCallback = callback;
    if (this.pickerInited && this.gisInited) {
      callback(true);
    }
  }

  public authorize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = async (response: any) => {
        if (response.error !== undefined) {
          reject(response);
          return;
        }
        this.accessToken = response.access_token;
        resolve();
        await this.createPicker();
      };

      if (this.accessToken === null) {
        this.tokenClient.requestAccessToken({ prompt: 'consent' });
      } else {
        this.tokenClient.requestAccessToken({ prompt: '' });
      }
    });
  }

  public signOut() {
    if (this.accessToken) {
      google.accounts.oauth2.revoke(this.accessToken);
      this.accessToken = null;
    }
  }

  public isAuthorized(): boolean {
    return this.accessToken !== null;
  }

  public onFileSelected(callback: (fileData: any) => void) {
    this.onFileSelectedCallback = callback;
  }

  private createPicker() {
    const view = new google.picker.View(google.picker.ViewId.DOCS);
    // view.setMimeTypes('application/vnd.msgpack'); does not work for some reason...
    const picker = new google.picker.PickerBuilder()
      .enableFeature(google.picker.Feature.NAV_HIDDEN)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setDeveloperKey(API_KEY)
      .setAppId(APP_ID)
      .setOAuthToken(this.accessToken)
      .addView(view)
      .addView(new google.picker.DocsUploadView())
      .setCallback((data: any) => this.pickerCallback(data))
      .build();
    picker.setVisible(true);
  }

  private async pickerCallback(data: any) {
    if (data.action === google.picker.Action.PICKED) {
      const documents = data[google.picker.Response.DOCUMENTS];
      const results = [];

      for (const document of documents) {
        const fileId = document[google.picker.Document.ID];
        const res = await gapi.client.drive.files.get({
          'fileId': fileId,
          'fields': '*',
        });
        results.push({
          pickerData: document,
          driveData: res.result
        });
      }

      if (this.onFileSelectedCallback) {
        this.onFileSelectedCallback(results);
      }
    }
  }
}
