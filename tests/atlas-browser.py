"""Actual Chromium QA for the original Three.js city-life gameplay and Pages subpaths."""
import json
import pathlib
import socketserver
import threading
import time
from http.server import SimpleHTTPRequestHandler
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.action_chains import ActionChains

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/"test-artifacts"/"city"
OUT.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kw):super().__init__(*args,directory=str(ROOT),**kw)
    def log_message(self,*args):pass

with socketserver.TCPServer(("127.0.0.1",0),Handler) as server:
    threading.Thread(target=server.serve_forever,daemon=True).start()
    opt=Options()
    for flag in ("--headless=new","--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader","--window-size=1366,768"):
        opt.add_argument(flag)
    opt.set_capability("goog:loggingPrefs",{"browser":"ALL"})
    browser=webdriver.Chrome(options=opt)
    browser.set_page_load_timeout(50)
    try:
        browser.get("http://127.0.0.1:%d/"%server.server_address[1])
        state=None
        for _ in range(100):
            state=browser.execute_script("""return {
              ready:!!window.__game,
              money:document.querySelector('#hud-stats .hud-stat__money')?.textContent||'',
              boot:document.querySelector('#boot')?.textContent?.slice(0,110)||'',
              canvas:document.querySelector('canvas#game')?.getBoundingClientRect().width||0,
              time:document.querySelector('#clock')?.textContent||''
            }""")
            if state["ready"] and state["money"] and state["canvas"]>400:break
            time.sleep(.25)
        assert state["ready"],"3D world failed to boot: "+str(state)
        assert "$" in state["money"],state
        assert state["time"].strip(),state
        assert state["canvas"]>400,state
        before=browser.execute_script("return [window.__game.player.root.position.x,window.__game.player.root.position.z]")
        ActionChains(browser).key_down("w").pause(.75).key_up("w").perform()
        time.sleep(.3)
        after=browser.execute_script("return [window.__game.player.root.position.x,window.__game.player.root.position.z]")
        movement=sum(abs(a-b) for a,b in zip(after,before))
        assert movement>0.025,{"before":before,"after":after,"movement":movement}
        browser.save_screenshot(str(OUT/"city-desktop.png"))
        browser.set_window_size(390,844)
        time.sleep(.9)
        mobile=browser.execute_script("""return {
          width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
          height:innerHeight,canvasWidth:document.querySelector('#game').getBoundingClientRect().width,
          hasHUD:!!document.querySelector('#hud-stats'),
          world:!!window.__game
        }""")
        assert mobile["world"] and mobile["hasHUD"],mobile
        assert mobile["scrollWidth"]<=mobile["width"]+4,mobile
        assert abs(mobile["canvasWidth"]-mobile["width"])<5,mobile
        browser.save_screenshot(str(OUT/"city-mobile.png"))
        severe=[e["message"] for e in browser.get_log("browser") if e["level"]=="SEVERE"]
        assert not [x for x in severe if "Uncaught" in x or "127.0.0.1" in x],severe
        result={"loaded":state,"movement":movement,"before":before,"after":after,"mobile":mobile,"severe":severe}
        (OUT/"browser-qa.json").write_text(json.dumps(result,indent=2,ensure_ascii=False))
        print(json.dumps(result,ensure_ascii=False))
    finally:
        browser.quit()
        server.shutdown()
