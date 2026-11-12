# Smoke test for the dev stack: fork before a message, whole fork (Codex), capabilities, terminal, files.
import json,urllib.request,time
B='http://127.0.0.1:8791'
def get(p): return json.load(urllib.request.urlopen(B+p))
def post(p,b):
    r=urllib.request.Request(B+p,data=json.dumps(b).encode(),headers={'Content-Type':'application/json'})
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {'HTTP':e.code,'body':e.read().decode()}
def wait(rid):
    for i in range(40):
        time.sleep(0.5); e=get('/api/runs/%s/events'%rid)
        if e['run']['status'] in('done','error','stopped'): break
    return e
d=get('/api/sessions')
s=[x for x in d['sessions'] if x['title'].startswith('重构侧栏')][0]
ms=get('/api/sessions/%s/messages?limit=80'%s['id'])['messages']
users=[m for m in ms if m['role']=='user']
r=post('/api/runs',{'prompt':'回顾一下','mode':'full','fork':{'session_id':s['id'],'kind':'edit','before_ts':users[1]['ts'],'before_text':users[1]['text'],'before_ord':users[1]['ord'],'title':'分支测试'}})
e=wait(r['run']['id'])
print('claude fork-before-2nd:', e['run']['status'], e['run'].get('error'), 'new session', e['run']['session_id']!=s['id'] and e['run']['session_id'])
for ev in e['events']:
    if ev['t']=='agent' and ev['data'].get('type')=='assistant': print('  A:',ev['data']['message']['content'][0].get('text','')[:200].replace('\n',' / '))
r=post('/api/runs',{'prompt':'回顾一下','mode':'full','fork':{'session_id':s['id'],'kind':'side'}})
e=wait(r['run']['id'])
for ev in e['events']:
    if ev['t']=='agent' and ev['data'].get('type')=='assistant': print('  whole fork A:',ev['data']['message']['content'][0].get('text','')[:200].replace('\n',' / '))
r=post('/api/runs',{'prompt':'回顾一下','mode':'full','fork':{'session_id':s['id'],'kind':'edit','before_ts':users[0]['ts'],'before_text':users[0]['text'],'before_ord':0}})
e=wait(r['run']['id'])
for ev in e['events']:
    if ev['t']=='agent' and ev['data'].get('type')=='assistant': print('  fork-before-first A:',ev['data']['message']['content'][0].get('text','')[:200].replace('\n',' / '))
d=get('/api/sessions'); print('meta', d['meta'])
print('caps', {m['name']: {k: (len(v.get('commands',[])), len(v.get('models',[]))) for k,v in (m.get('caps') or {}).items()} for m in d['machines'] if m['runner']})
c=[x for x in d['sessions'] if x['agent']=='codex' and x['machine']=='dev'][0]
e=wait(post('/api/runs',{'prompt':'continue in a fork','fork':{'session_id':c['id'],'kind':'branch'}})['run']['id'])
print('codex fork', e['run']['status'], e['run'].get('error'), e['run']['session_id'], 'parent', c['id'])
t=post('/api/terms',{'machine':'dev','key':'smoke','cwd':'/tmp','cols':80,'rows':24})['term']['id']; time.sleep(1.2)
post('/api/terms/%s/input'%t,{'data':'echo term-$((6*7))\n'}); time.sleep(1)
import base64
print('terminal', 'term-42' in base64.b64decode(get('/api/terms/'+t)['data']).decode('utf8','replace')); post('/api/terms/%s/close'%t,{})
print('files', len(post('/api/fs/list',{'machine':'dev','path':'/tmp'}).get('entries',[]))>=0)
