import './style.css';
import { App } from './ui/app';

declare global {
  interface Window {
    /** The running app, exposed for debugging and end-to-end tests. */
    __mouthpiece?: App;
  }
}

const root = document.getElementById('app');
if (root) window.__mouthpiece = new App(root);
