'use strict';

const fs = require('fs');
const { t } = require('../i18n');

// File types Windows will execute when opened; these are never opened directly from mail.
const RISKY = /\.(exe|bat|cmd|com|scr|pif|lnk|url|hta|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|psd1|msi|msp|mst|reg|cpl|jar|appref-ms|application|gadget|inf|scf|sct|chm|iso|img|vhd|vhdx|msc|xll|library-ms|settingcontent-ms)$/i;

// Flattens an attachment name to a single safe file name: no folders, no bidi tricks.
function safeName(name) {
  const flat = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return flat || t('native.attachments.defaultName');
}

// Marks a file as downloaded from the internet so SmartScreen and Office Protected View apply.
function markOfTheWeb(file) {
  if (process.platform !== 'win32') return;
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  } catch (_) {
    // Not NTFS (FAT32 stick, network share): nothing to mark.
  }
}

module.exports = { RISKY, safeName, markOfTheWeb };
