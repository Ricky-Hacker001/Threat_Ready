// Foundations scenarios (F3 is the existing s02-authfail module, see legacy.js).
import F1 from './F01-lockout.js';
import F2 from './F02-kerberos.js';
import F4 from './F04-av-quarantine.js';
import F5 from './F05-phish-report.js';
import F6 from './F06-after-hours.js';
import F7 from './F07-new-account.js';
import F8 from './F08-blocked-site.js';
import F9 from './F09-port-scan.js';
import F10 from './F10-usb.js';
import F11 from './F11-vpn-spray.js';
import F12 from './F12-disabled-account.js';

export const FOUNDATIONS = [F1, F2, F4, F5, F6, F7, F8, F9, F10, F11, F12];
