import sqlite3, json

c = sqlite3.connect('data/papermind.db')
row = c.execute("SELECT value FROM app_state WHERE key='workspace'").fetchone()
obj = json.loads(row[0])
print('TOP KEYS:', list(obj.keys()) if isinstance(obj, dict) else type(obj))

def find_paper(o, path='root', depth=0):
    if depth > 6:
        return
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ('selectedPaper', 'paper', 'currentPaper') or (k == 'authors'):
                print(f'FOUND {path}.{k} => type={type(v).__name__} value={json.dumps(v, ensure_ascii=False)[:400]}')
            find_paper(v, f'{path}.{k}', depth+1)
    elif isinstance(o, list):
        for i, v in enumerate(o[:3]):
            find_paper(v, f'{path}[{i}]', depth+1)

find_paper(obj)
