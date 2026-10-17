"""Normative JSON Schema generator; Python 3 standard library only.
Porting to C# source-generated contracts must preserve the generated schemas.
"""
import json
from pathlib import Path

def obj(properties, required=(), **rules):
    return {'type':'object','properties':properties,'required':list(required),
            'additionalProperties':False, **rules}
def arr(item, maximum=1000):
    return {'type':'array','items':item,'maxItems':maximum}
def enum(*values): return {'type':'string','enum':list(values)}
def integer(lo=0, hi=None):
    return {'type':'integer','minimum':lo, **({'maximum':hi} if hi is not None else {})}
def text(maximum=4096): return {'type':'string','maxLength':maximum}
def ref(name): return {'$ref':'#/$defs/'+name}
def nullable(schema): return {'anyOf':[schema,{'type':'null'}]}
ID={'type':'string','minLength':1,'maxLength':512}
HASH={'type':'string','pattern':'^sha256:[0-9a-f]{64}$'}
BOOL={'type':'boolean'}
NUMBER={'type':'number'}
POSITION=obj({'line':integer(),'character':integer()},['line','character'])
RANGE=obj({'start':POSITION,'end':POSITION},['start','end'])
FRESH=enum('prefer_current','allow_stale','require_current')
RESOLUTION=enum('resolved','possible','unresolved','syntaxOnly')
PROVENANCE=enum('compiler','syntax','heuristic','documentation','generated','metadata')
CHANNEL=enum('exact','lexical','vector','alias','graph')
COMMON={'repositoryId':ID,'contextId':ID,'freshness':FRESH,
        'responseBudgetTokens':integer(512,8000)}
FILTERS=obj({'projectIds':arr(ID,50),'languages':arr(text(32),10),'kinds':arr(text(64),50)})
SYMBOL={'symbolId':ID}
PAGE={'limit':integer(1,100),'cursor':text(4096)}

inputs={
 'search_code':obj({**COMMON,'query':{'type':'string','minLength':1,'maxLength':2000},
     'limit':integer(1,50),'filters':FILTERS,'expandGraph':BOOL,
     'mode':enum('hybrid','lexical','vector'),'cursor':text(4096)},['repositoryId','query']),
 'find_symbol':obj({**COMMON,'name':ID,'qualifiedName':ID,'signature':text(8192),
     'limit':integer(1,50),'cursor':text(4096)},['repositoryId','name']),
 'get_symbol':obj({**COMMON,**SYMBOL},['repositoryId','symbolId']),
 'get_source':obj({**COMMON,**SYMBOL,'fileId':ID,'locationId':ID,'range':RANGE,
     'expectedContentHash':HASH,'maxLines':integer(1,200)},['repositoryId'],oneOf=[
       {'required':['symbolId'],'not':{'anyOf':[{'required':['fileId']},{'required':['range']}]},
        'allOf':[{'if':{'required':['expectedContentHash']},'then':{'required':['locationId']}}]},
       {'required':['fileId','range'],'not':{'anyOf':[{'required':['symbolId']},{'required':['locationId']}]}}
     ]),
 'explain_symbol':obj({**COMMON,**SYMBOL,'includeGenerated':BOOL},['repositoryId','symbolId']),
 'get_callers':obj({**COMMON,**SYMBOL,**PAGE,'includePossibleTargets':BOOL},['repositoryId','symbolId']),
 'get_callees':obj({**COMMON,**SYMBOL,**PAGE,'includePossibleTargets':BOOL},['repositoryId','symbolId']),
 'trace_flow':obj({**COMMON,**SYMBOL,'direction':enum('outgoing','incoming'),
     'depth':integer(0,10),'maxNodes':integer(1,1000),'maxEdges':integer(1,2000),
     'edgeKinds':arr(text(64),30),'includePossibleTargets':BOOL},['repositoryId','symbolId']),
 'find_related':obj({**COMMON,**SYMBOL,'kinds':arr(text(64),30),'limit':integer(1,50),
     'cursor':text(4096)},['repositoryId','symbolId']),
 'summarize_project':obj({**COMMON,'projectId':ID,'includeGenerated':BOOL},['repositoryId','projectId']),
 'get_index_status':obj({'repositoryId':ID,'responseBudgetTokens':integer(512,8000)},['repositoryId'])
}

DEFS={}
DEFS['Range']=RANGE
DEFS['Coverage']=obj({k:integer() for k in ['eligible','current','stale','excluded','failed']},
                     ['eligible','current','stale','excluded','failed'])
DEFS['Warning']=obj({'code':ID,'message':text(),'retryable':BOOL},['code','message'])
DEFS['Freshness']=obj({'state':enum('current','partial','stale','unknown'),
 'lastReconciledUtc':nullable(text(40)),'pendingContextCount':integer(),
 'basis':{'const':'observedSnapshot'}},['state','lastReconciledUtc','pendingContextCount','basis'])
DEFS['Evidence']=obj({'id':ID,'fileId':ID,'contextId':ID,'path':text(4096),
 'contentHash':HASH,'range':ref('Range'),'provenance':PROVENANCE,'resolution':RESOLUTION,
 'referenceIdentity':text(),'description':text()},['id','provenance','resolution'],oneOf=[
   {'required':['fileId','contextId','path','contentHash','range'],
    'not':{'required':['referenceIdentity']}},
   {'required':['referenceIdentity'],'not':{'required':['fileId']}}
 ])
DEFS['Symbol']=obj({'symbolId':ID,'contextId':nullable(ID),'kind':text(64),'qualifiedName':text(4096),
 'signature':text(8192),'symbolRevision':HASH,'external':BOOL,'resolution':RESOLUTION,
 'declarations':arr(ID,1000),'identityStability':enum('semantic','localEditSensitive','syntactic')},
 ['symbolId','contextId','kind','qualifiedName','signature','symbolRevision','external','resolution','declarations','identityStability'])
DEFS['Fact']=obj({'kind':text(64),'text':text(8192),'evidenceIds':arr(ID,100),
 'provenance':PROVENANCE,'resolution':RESOLUTION,'sourceRevision':HASH},
 ['kind','text','evidenceIds','provenance','resolution','sourceRevision'])
DEFS['Description']=obj({'text':text(16384),'provenance':PROVENANCE,'inputRevision':HASH,
 'evidenceIds':arr(ID,1000),'state':enum('ready','pending','failed','stale','unavailable')},
 ['text','provenance','inputRevision','evidenceIds','state'])
DEFS['Relation']=obj({'edgeId':ID,'sourceSymbolId':ID,'targetSymbolId':ID,'kind':text(64),
 'resolution':RESOLUTION,'provenance':PROVENANCE,'evidenceIds':arr(ID,100)},
 ['edgeId','sourceSymbolId','targetSymbolId','kind','resolution','provenance','evidenceIds'])
# get_callers/get_callees: the relation plus the symbol at its other end (the caller, or the
# callee), so a reader does not need a get_symbol round trip per item.
DEFS['CallRelation']=obj({**DEFS['Relation']['properties'],'symbol':ref('Symbol')},
 DEFS['Relation']['required']+['symbol'])
DEFS['Boundary']=obj({'symbolId':ID,'reason':text(256),'omittedCount':nullable(integer())},['symbolId','reason'])
DEFS['ContextStatus']=obj({'contextId':ID,'state':text(64),'resolution':enum('complete','partial','syntaxOnly'),
 'desiredRevision':integer(),'publishedRevision':integer(),'capabilities':arr(text(64),30)},
 ['contextId','state','resolution','desiredRevision','publishedRevision','capabilities'])
DEFS['Diagnostic']=obj({'id':ID,'code':ID,'severity':enum('info','warning','error'),
 'message':text(4096),'contextId':ID,'fileId':ID},['id','code','severity','message'])
DEFS['ModelStatus']=obj({'fingerprint':HASH,'state':enum('building','active','retiring','failed'),
 'dimensions':integer(1,8192),'coverage':ref('Coverage')},['fingerprint','state','dimensions','coverage'])
match=obj({'symbol':ref('Symbol'),'reasons':arr(CHANNEL,5),'evidenceIds':arr(ID,100),
 'ranks':obj({x:integer(1) for x in ['exact','lexical','vector','alias']}),
 'score':NUMBER,'freshness':enum('current','stale'),'seedSymbolId':ID},
 ['symbol','reasons','evidenceIds','ranks','score','freshness'])
fragment=obj({'fileId':ID,'locationId':ID,'text':text(131072),'range':ref('Range'),
 'currentHash':HASH,'indexedHash':nullable(HASH),'matchesIndexedRevision':BOOL},
 ['fileId','text','range','currentHash','indexedHash','matchesIndexedRevision'])
related=obj({'symbol':ref('Symbol'),'reasons':arr(text(128),30),'evidenceIds':arr(ID,100)},
 ['symbol','reasons','evidenceIds'])
component=obj({'symbol':ref('Symbol'),'description':nullable(ref('Description')),
 'evidenceIds':arr(ID,100)},['symbol','description','evidenceIds'])

data={
 'search_code':obj({'matches':arr(match,50),'channelsUsed':arr(CHANNEL,5),
   'eligibleSymbolCount':integer(),'vectorCoveredSymbolCount':integer()},
   ['matches','channelsUsed','eligibleSymbolCount','vectorCoveredSymbolCount']),
 'find_symbol':obj({'items':arr(ref('Symbol'),50),'ambiguous':BOOL},['items','ambiguous']),
 'get_symbol':obj({'symbol':ref('Symbol'),'declarations':arr(ID,1000),
   'referencesAvailable':BOOL,'resolution':RESOLUTION,'diagnosticIds':arr(ID,1000)},
   ['symbol','declarations','referencesAvailable','resolution','diagnosticIds']),
 'get_source':obj({'fragments':arr(fragment,100)},['fragments']),
 'explain_symbol':obj({'facts':arr(ref('Fact'),100),'description':nullable(ref('Description')),
   'provenance':PROVENANCE,'uncertainties':arr(text(),100),'coverage':ref('Coverage')},
   ['facts','description','provenance','uncertainties','coverage']),
 'get_callers':obj({'items':arr(ref('CallRelation'),100)},['items']),
 'get_callees':obj({'items':arr(ref('CallRelation'),100)},['items']),
 'trace_flow':obj({'nodes':arr(ref('Symbol'),1000),'edges':arr(ref('Relation'),2000),
   'boundaries':arr(ref('Boundary'),1000),'unresolvedOccurrences':arr(ID,1000),
   'limitsApplied':obj({'depth':integer(0,10),'maxNodes':integer(1,1000),
                       'maxEdges':integer(1,2000)},['depth','maxNodes','maxEdges'])},
   ['nodes','edges','boundaries','unresolvedOccurrences','limitsApplied']),
 'find_related':obj({'items':arr(related,50)},['items']),
 'summarize_project':obj({'projectId':ID,'components':arr(component,100),
   'description':nullable(ref('Description')),'coverage':ref('Coverage'),
   'uncertainties':arr(text(),100)},['projectId','components','description','coverage','uncertainties']),
 'get_index_status':obj({'desiredRevision':integer(),'contexts':arr(ref('ContextStatus'),1000),
   'jobsByState':obj({k:integer() for k in ['pending','leased','succeeded','failed','obsolete']},
                    ['pending','leased','succeeded','failed','obsolete']),
   'models':arr(ref('ModelStatus'),10),'lastReconciledUtc':nullable(text(40)),
   'diagnostics':arr(ref('Diagnostic'),1000),'ownerState':text(64)},
   ['desiredRevision','contexts','jobsByState','models','lastReconciledUtc','diagnostics','ownerState'])
}

def output_schema(tool):
    base={'schemaVersion':{'const':'1.2'},'repositoryId':ID,
          'indexGeneration':nullable(integer()),'queryEpoch':nullable(integer())}
    required=list(base)
    success=obj({**base,'indexGeneration':integer(),'queryEpoch':integer(),
      'freshness':ref('Freshness'),'data':data[tool],'evidence':arr(ref('Evidence'),2000),
      'warnings':arr(ref('Warning'),100),'truncated':BOOL,'nextCursor':nullable(text(4096)),
      'truncationReasons':arr(text(256),30),'minimumUsefulBudgetTokens':integer(),
      'omittedCounts':{'type':'object','additionalProperties':integer()}},
      required+['freshness','data','evidence','warnings','truncated','nextCursor'])
    error=obj({**base,'error':obj({'code':ID,'message':text(),'retryable':BOOL,
      'retryAfterMs':integer(0,300000)},['code','message','retryable'])},required+['error'])
    return {'$schema':'https://json-schema.org/draft/2020-12/schema',
            '$defs':DEFS,'oneOf':[success,error]}

contracts={name:{'inputSchema':{'$schema':'https://json-schema.org/draft/2020-12/schema',**schema},
                 'outputSchema':output_schema(name)} for name,schema in inputs.items()}

if __name__=='__main__':
    target=Path(__file__).resolve().parent.parent / 'contracts.json'
    target.write_text(json.dumps(contracts,indent=2)+'\n',encoding='utf-8')
    print(f'Wrote {len(contracts)} tool contracts to {target}')
