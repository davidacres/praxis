'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('canvas');

const SIZE = 128;
const OUT = path.join(__dirname, '..', 'media', 'marketplace-icon.png');

const BG_TOP = '#4f8ff7';
const BG_BOTTOM = '#1d4ed8';
const TICKET = '#ffffff';
const LINE = '#c7ddff';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTicketIcon(ctx) {
  const x = 30;
  const y = 38;
  const w = 68;
  const h = 48;
  const r = 8;
  const notch = 7;

  ctx.beginPath();
  ctx.moveTo(x + r + notch, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h / 2 - notch);
  ctx.quadraticCurveTo(x + w + notch, y + h / 2, x + w, y + h / 2 + notch);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r + notch, y + h);
  ctx.quadraticCurveTo(x + notch, y + h, x + notch, y + h - r);
  ctx.lineTo(x + notch, y + h / 2 + notch);
  ctx.quadraticCurveTo(x - notch, y + h / 2, x + notch, y + h / 2 - notch);
  ctx.lineTo(x + notch, y + r);
  ctx.quadraticCurveTo(x + notch, y, x + r + notch, y);
  ctx.closePath();
  ctx.fillStyle = TICKET;
  ctx.fill();

  ctx.fillStyle = LINE;
  roundRect(ctx, x + 22, y + 14, 38, 5, 2.5);
  ctx.fill();
  roundRect(ctx, x + 22, y + 27, 26, 5, 2.5);
  ctx.fill();
}

const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
gradient.addColorStop(0, BG_TOP);
gradient.addColorStop(1, BG_BOTTOM);
ctx.fillStyle = gradient;
roundRect(ctx, 8, 8, 112, 112, 26);
ctx.fill();

drawTicketIcon(ctx);

fs.writeFileSync(OUT, canvas.toBuffer('image/png'));
console.log(`Wrote ${OUT}`);
