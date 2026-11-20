"""Measure the running demo over loopback HTTP; this does not measure browser rendering.

backend/.venv/bin/python scripts/benchmark_network_stress_demo.py --base-url http://127.0.0.1:8767
"""

import argparse
import gzip
import json
import math
import statistics
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://127.0.0.1:8767')
    parser.add_argument('--out',type=Path,default=ROOT/'backend/data/network-stress-30000/http-benchmark.json')
    parser.add_argument('--repeats',type=int,default=7)
    args=parser.parse_args()
    if not 2<=args.repeats<=50:
        parser.error('Use between 2 and 50 measurements per endpoint.')

    def get(route,params=None,raw=False):
        url=args.base_url.rstrip('/')+'/api/simulation/'+route+('?' + urlencode(params) if params else '')
        started=time.perf_counter()
        with urlopen(Request(url,headers={'Accept-Encoding':'gzip'}),timeout=60) as response:
            wire=response.read()
            body=gzip.decompress(wire) if response.headers.get('Content-Encoding')=='gzip' else wire
        result=body if raw else json.loads(body)
        return result,(time.perf_counter()-started)*1000,len(wire),len(body)

    timeline,*_=get('network/timeline')
    analysis=timeline['analysis']
    match,*_=get('maps/stress-30000/match',{'analysis':analysis})
    assert match['counts']=={'layers':30000,'matched':30000,'elements':30000,'elements_without_layer':0}
    times=timeline['times']
    scenarios=timeline['scenarios']
    elements=match['elements']
    layout = None

    def display_hour(k):
        nonlocal layout
        params = {'scenario': scenarios[0]['id'], 't': times[k % len(times)], 'display': 'true'}
        if layout:
            params['known_layout'] = layout
        response = get('maps/stress-30000/values', params)
        body = response[0]
        assert len(body['v']) == len(elements) and 'r' not in body
        assert all((field in body) == (layout != body['layout']) for field in ('m', 'lo', 'up'))
        layout = body['layout']
        return response

    requests={
        'svg':lambda k:get('maps/stress-30000.svg',raw=True),
        'map_match':lambda k:get('maps/stress-30000/match',{'analysis':analysis}),
        'map_hour_scenario':lambda k:get('maps/stress-30000/values',{'scenario':scenarios[k%len(scenarios)]['id'],'t':times[k%len(times)]}),
        'network_hour_all_scenarios':lambda k:get('network/at-time',{'analysis':analysis,'t':times[k%len(times)]}),
        'equipment_hover_all_scenarios':lambda k:get('network/equipment-at-time',{'analysis':analysis,'t':times[k%len(times)],'element':elements[(k*349)%len(elements)][0]}),
        'map_display_consecutive_hours': display_hour,
    }
    report={'mode':'loopback HTTP, gzip, decompression and JSON decoding; server already running; OS/server caches may be warm; no browser rendering',
            'equipment':match['counts']['matched'],'scenarios':len(scenarios),'hours':len(times),'requests':{}}
    for name,request in requests.items():
        samples=[]
        for k in range(args.repeats):
            result,ms,wire,size=request(k)
            if name=='map_hour_scenario':assert len(result['v'])==30000
            if name=='equipment_hover_all_scenarios':assert len(result['scenarios'])==6
            samples.append({'ms':round(ms,2),'wire_bytes':wire,'decoded_bytes':size})
        ordered=sorted(s['ms'] for s in samples)
        summary={'first_ms':samples[0]['ms'],'median_ms':round(statistics.median(ordered),2),
                 'p95_ms':ordered[math.ceil(len(ordered)*0.95)-1],'samples':samples}
        report['requests'][name]=summary
        print(name,summary['median_ms'],'ms median;',summary['p95_ms'],'ms p95',flush=True)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(report,indent=2)+'\n')
    print('Report:',args.out)


if __name__=='__main__':
    main()
