import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';
const html=readFileSync('index.html','utf8');
test('root page loads original city world from relative modules',()=>{
 assert.match(html,/\.\/src\/three\/main\.js/);assert.match(html,/\.\/styles\/game\.css/);
 assert.match(html,/\.\/assets\/vendor\/three\/three\.module\.js/);
 for(const p of ['src/three/main.js','styles/game.css','assets/vendor/three/three.module.js','.nojekyll','LICENSE'])assert.ok(existsSync(p),p);
});
test('Fork preserves upstream MIT attribution and distinct preview metadata',()=>{
 assert.match(readFileSync('LICENSE','utf8'),/MIT License/);
 assert.match(readFileSync('ATLAS_FORK_DEVELOPMENT.md','utf8'),/Mon-ius\/City-of-Small-Chances/);
 assert.match(html,/https:\/\/aincfh\.github\.io\/City-of-Small-Chances\//);
});
test('original debug/test hook exists without modifying gameplay',()=>{
 assert.match(readFileSync('src/three/main.js','utf8'),/window\.__game/);
 assert.match(readFileSync('src/three/main.js','utf8'),/requestAnimationFrame/);
});
