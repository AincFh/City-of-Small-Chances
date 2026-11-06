"""Actual Chromium QA: an in-world job funds food, equipment and training, saved across reload."""
import json
import pathlib
import socketserver
import threading
import time
from http.server import SimpleHTTPRequestHandler
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.support.ui import WebDriverWait

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/"test-artifacts"/"harbor-life"
OUT.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kw):super().__init__(*args,directory=str(ROOT),**kw)
 def log_message(self,*args):pass

with socketserver.TCPServer(("127.0.0.1",0),Handler) as server:
 threading.Thread(target=server.serve_forever,daemon=True).start()
 opt=Options()
 for flag in ("--headless=new","--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader","--window-size=1280,800"):
  opt.add_argument(flag)
 opt.set_capability("goog:loggingPrefs",{"browser":"ALL"})
 browser=webdriver.Chrome(options=opt)
 wait=WebDriverWait(browser,50)
 try:
  browser.get("http://127.0.0.1:%d/"%server.server_address[1])
  wait.until(lambda b:b.execute_script("return !!window.__game"))
  def snapshot():
   return browser.execute_script("""const g=window.__game,p=g.pstate;
      return {money:p.money,energy:p.energy,shifts:p.shiftsWorked,
       bicycle:p.inventory.bicycle,focus:p.skills.focus,meals:p.mealsEaten,
       rest:p.restsTaken,study:p.studySessions,day:g.day.day,minute:Math.floor(g.day.minutes)}""")
  def visit(x,z,title):
   browser.execute_script("window.__game.player.root.position.set(arguments[0],0,arguments[1])",x,z)
   wait.until(lambda b:b.execute_script("return !!window.__game.interactions.nearest()"))
   ActionChains(browser).send_keys("e").perform()
   wait.until(lambda b:b.execute_script("return !document.querySelector('#hud-panel').hidden"))
   assert title in browser.find_element(By.ID,"hud-panel").text,browser.find_element(By.ID,"hud-panel").text
  def click_number(i):
   # In-game buttons are the actual rendered menu buttons; no direct act() hooks.
   btns=browser.find_elements(By.CSS_SELECTOR,"#hud-panel .panel__act")
   target=[x for x in btns if x.find_element(By.CSS_SELECTOR,".panel__act-key").text==str(i)]
   assert len(target)==1,{"index":i,"buttons":[x.text for x in btns]}
   target[0].click()
   time.sleep(.15)
  def close():
   browser.find_element(By.CSS_SELECTOR,"#hud-panel .panel__close").click()
   wait.until(lambda b:b.execute_script("return document.querySelector('#hud-panel').hidden"))
  initial=snapshot()
  assert initial["money"]==240 and initial["energy"]==100 and initial["focus"]==0,initial
  visit(5,-6,"notice board")
  assert len(browser.find_elements(By.CSS_SELECTOR,".panel__act"))>=1
  browser.save_screenshot(str(OUT/"01-work-board.png"))
  click_number(1)
  worked=snapshot()
  assert worked["shifts"]==1 and worked["money"]==278 and worked["energy"]==85,worked
  assert worked["minute"]>=630,worked
  close()
  visit(-5,4,"Mei")
  board=browser.execute_script("""return {open:[...document.querySelectorAll('#hud-panel .panel__act')].map(x=>x.textContent),
   locked:[...document.querySelectorAll('#hud-panel .panel__row')].map(x=>x.textContent)}""")
  assert any("noodle" in x.lower() for x in board["open"]),board
  browser.save_screenshot(str(OUT/"02-mei-services.png"))
  click_number(1) # Meal: $12 / +23 energy / 35 minutes
  fed=snapshot()
  assert fed["money"]==266 and fed["energy"]==100 and fed["meals"]==1,fed
  click_number(3) # Bicycle: $95
  equipped=snapshot()
  assert equipped["bicycle"] and equipped["money"]==171,equipped
  assert any("already own a bicycle" in x.lower() for x in
    [el.text for el in browser.find_elements(By.CSS_SELECTOR,"#hud-panel .panel__row")])
  click_number(4) # First focus session $18, -8 energy, +5 focus
  first=snapshot()
  assert first["focus"]==5 and first["study"]==1 and first["money"]==153,first
  click_number(4)
  trained=snapshot()
  assert trained["focus"]==10 and trained["study"]==2 and trained["money"]==135,trained
  assert not any("Practice filing" in x.text for x in browser.find_elements(By.CSS_SELECTOR,"#hud-panel .panel__act"))
  browser.save_screenshot(str(OUT/"03-trained-with-bicycle.png"))
  close()
  visit(5,-6,"notice board")
  career=browser.execute_script("""return {
   courier:[...document.querySelectorAll('#hud-panel li')].find(x=>x.textContent.includes('Bike courier run'))?.textContent,
   clerk:[...document.querySelectorAll('#hud-panel li')].find(x=>x.textContent.includes('Civic records desk'))?.className,
   money:window.__game.pstate.money,
   inStorage:JSON.parse(localStorage.getItem('city-small-chances:harbor-life:v1'))?.skills?.focus
  }""")
  assert career["clerk"]=="panel__actrow",career
  assert career["inStorage"]==10 and "bicycle" not in (career["courier"] or "").lower(),career
  browser.save_screenshot(str(OUT/"04-unlocked-career.png"))
  close()
  browser.refresh()
  wait.until(lambda b:b.execute_script("return !!window.__game"))
  restored=snapshot()
  for k in ("money","energy","shifts","bicycle","focus","meals","study","day"):
   assert restored[k]==trained[k],{"key":k,"before":trained,"after":restored}
  assert abs(restored["minute"]-trained["minute"])<=3,restored
  browser.set_window_size(390,844)
  visit(-5,4,"Mei")
  mobile=browser.execute_script("""const el=document.querySelector('#hud-panel .panel__card'),r=el.getBoundingClientRect();
   return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,
    actions:document.querySelectorAll('#hud-panel .panel__act').length,
    locked:document.querySelectorAll('#hud-panel .panel__row.is-locked').length}""")
  assert mobile["left"]>=0 and mobile["right"]<=mobile["viewport"]+3,mobile
  assert mobile["scroll"]<=mobile["viewport"]+4 and mobile["actions"]>0,mobile
  browser.save_screenshot(str(OUT/"05-mobile-harbor-life.png"))
  errors=[x["message"] for x in browser.get_log("browser") if x["level"]=="SEVERE"]
  assert not [x for x in errors if "Uncaught" in x or "127.0.0.1" in x],errors
  report={"status":"PASS","worked":worked,"meal":fed,"equipped":equipped,"trained":trained,
    "career":career,"restored":restored,"mobile":mobile,"errors":errors}
  (OUT/"harbor-life-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
  print(json.dumps(report,ensure_ascii=False),flush=True)
 finally:
  browser.quit()
  server.shutdown()
