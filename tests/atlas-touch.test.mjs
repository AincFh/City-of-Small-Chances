import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const html=readFileSync('index.html','utf8'),js=readFileSync('src/three/input.js','utf8'),css=readFileSync('styles/game.css','utf8');
test('four accessible real pointer controls and interact button exist',()=>{for(const d of ['up','down','left','right'])assert.match(html,new RegExp('data-touch-dir="'+d+'"'));assert.match(html,/id="touch-interact"/);assert.match(html,/aria-label="Walk forward"/)});
test('touch movement is combined with keyboard and cleared on blur/release',()=>{assert.match(js,/touchKeys/);assert.match(js,/pointercancel/);assert.match(js,/lostpointercapture/);assert.match(js,/this\.touchCleanup\.forEach/);assert.match(js,/this\.keys\.has\(key\) \|\| this\.touchKeys\.has\(key\)/)});
test('touch controls appear on phones and never scroll the document',()=>{assert.match(css,/@media \(pointer:coarse\),\(max-width:680px\)/);assert.match(css,/touch-action:none/);});
