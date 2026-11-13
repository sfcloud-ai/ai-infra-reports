"""Run the paired Brief's real ledger with offline verified plans and fake WeCom IO."""
import base64,json,sys
sys.path.insert(0,sys.argv[1])
from test_page_delivery import PageDeliveryTests
from page_delivery import notice_text
from test_notice_connector import NOTICE_CONFIG
case=PageDeliveryTests();case.setUp()
try:
 receipts=[]
 for item in json.load(sys.stdin):
  raw=base64.b64decode(item['bundle_base64']);report=item['report'];rid=item['request_id']
  state={**report['page_delivery'],'articles':[{k:a[k] for k in ('id','title','sha256')} for a in report['articles']]}
  plan={**case.plan,'report_request_id':rid,'report_date':report['date'],'report_commit':item['commit'],'bundle_sha256':item['hash'],'notice_key':NOTICE_CONFIG['notice_connector']['report_base_url']+report['date']+'/','page_state':state}
  if report['revision']>1:plan['revision_notice']={'revision':report['revision'],**report['revision_notice']}
  plan['text']=notice_text(report['date'],[{**a,'url':plan['notice_key']+a['id']+'/'} for a in state['articles']],state)
  case.plans[item['hash']]=plan
  case.q.admit(rid,raw,item['commit'])
  if item.get('unknown'):case.outcomes=['unknown']
  for _ in range(4):case.advance()
  receipts.append(case.q.status(rid))
 print(json.dumps(receipts))
finally:case.tearDown()
