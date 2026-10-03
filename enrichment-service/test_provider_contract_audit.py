"""Strict contracts from upstream schema, including null values and inline images."""
import json, re, unittest
import httpx
from enrichment_service.models import EnrichRequest
from enrichment_service.providers import Provider
from enrichment_service.sources.stashbox import StashBoxSource
from enrichment_service.sources.stash import StashSource

BRIDGE=Provider(id='stash',name='Stash',kind='stash',endpoint='http://stash.invalid/graphql',api_key='k')
BOX='https://fixture.invalid/graphql'

class ProviderContractAudit(unittest.IsolatedAsyncioTestCase):
    async def test_standard_performer_fields_validate_in_search_and_exact_queries(self):
        # stashapp/stash-box graphql/schema/types/performer.graphql type Performer
        allowed = set('id name disambiguation aliases gender birth_date ethnicity country eye_color hair_color height cup_size band_size waist_size hip_size breast_type career_start_year career_end_year urls url site images'.split())
        captured=[]
        def handle(request):
            payload=json.loads(request.content)
            if str(request.url)==BRIDGE.endpoint:
                if 'stashBoxes' in payload['query']:
                    return httpx.Response(200,json={'data':{'configuration':{'general':{'stashBoxes':[{'endpoint':BOX,'name':'FansDB','api_key':'x','max_requests_per_minute':0}]}}}})
                return httpx.Response(200,json={'data':{'scrapeSinglePerformer':[{'name':'Creator','remote_site_id':'remote'}]}})
            captured.append(payload)
            q=payload['query'];selection=q[q.index('){')+2:];selection=selection[selection.index('{')+1:]
            unknown=set(re.findall(r'\b[a-z][a-z_]*\b',selection))-allowed
            if unknown:return httpx.Response(200,json={'errors':[{'message':f'Unknown fields: {sorted(unknown)}'}]})
            return httpx.Response(200,json={'data':{'findPerformer':{'id':'remote','name':'Creator','birth_date':'1990-01-01','images':[], 'urls':[]}}})
        source=StashBoxSource(name='fansdb',endpoint=BOX,api_key='fixture',dialect='standard',bridge=BRIDGE)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            for request in [EnrichRequest(name='Creator'),EnrichRequest(name='Creator',external_ids=[{'source':'fansdb','external_id':'remote'}])]:
                candidates=await source.search(request,client)
                self.assertTrue(any(c.type=='external_id' for c in candidates))
                self.assertTrue(any(c.field_key=='birth_date' for c in candidates))
        # Search finds the performer through Stash, then reads the exact record directly.
        self.assertEqual(len(captured),2)
        self.assertTrue(all('death_date' not in c['query'] for c in captured))

    async def test_null_scene_title_preserves_other_metadata(self):
        def handle(request):
            payload=json.loads(request.content)
            if 'stashBoxes' in payload['query']:
                return httpx.Response(200,json={'data':{'configuration':{'general':{'stashBoxes':[{'endpoint':BOX,'name':'FansDB','api_key':'x','max_requests_per_minute':0}]}}}})
            return httpx.Response(200,json={'data':{'scrapeSingleScene':[{'remote_site_id':'scene','title':None,'details':'Description','performers':[{'name':'Creator','remote_site_id':'creator'}]}]}})
        source=StashBoxSource(name='fansdb',endpoint=BOX,api_key='fixture',dialect='standard',bridge=BRIDGE)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows=await source.search(EnrichRequest(name='File',entity_type='scene'),client)
        self.assertTrue(any(c.type=='external_id' for c in rows))
        self.assertTrue(any(c.type=='performer' and c.value=='Creator' for c in rows))

    async def test_scraper_bio_and_inline_image_share_creator_match(self):
        image='data:image/png;base64,aGVsbG8='
        def handle(request):return httpx.Response(200,json={'data':{'scrapePerformerURL':{'name':'Creator','details':'Bio','images':[image],'urls':[],'birthdate':None,'aliases':None}}})
        source=StashSource(Provider(id='stash',name='Stash',kind='stash',endpoint='http://fixture.invalid/graphql'))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            rows=await source.search(EnrichRequest(name='Creator',scraper_url='https://fixture.invalid/profile'),client)
        self.assertTrue(any(c.type=='bio' for c in rows));self.assertTrue(any(c.value==image for c in rows))
        for row in rows:self.assertEqual(row.raw['match'],{'entity_type':'creator','source':'stash','external_id':None,'name':'Creator'})
        self.assertFalse(any(c.type=='external_id' for c in rows))
