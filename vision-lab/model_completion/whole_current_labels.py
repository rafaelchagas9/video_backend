"""Human-defined saved whole-review labels; mixed edited clips remain unknown."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import fine_labels as fl
from channel_partial_order import channel_key, digest, immutable_write, timestamp, unique

POLICY = 'whole-recording-current-review-v1'
SEMANTICS = {
 'policy':POLICY,'authority':'Direct user clarification on2026-10-10',
 'target':'current_whole_recording_review',
 'positive':'An explicit keep_whole reason on a saved kept proposal confirms retaining the entire current recording.',
 'negative':'A nonempty saved recording review with every proposal skipped rejects the entire current recording.',
 'unknown':'Every other recording, including95-100percent coverage of kept edited clips; the user confirmed near-full coverage means only the edited clips.',
 'permanent_storage_worth':'Unknown; no future expiry/replacement label is created.',
 'legacy_coverage_proxy':'Invalidated. Coverage>=.95 is not a whole positive, and a mixed recording below any coverage threshold is not a whole negative.'
}


def build(cohort,snapshot):
 unique(snapshot['records'],'id','feedback');recs=unique(cohort['recordings'],'video_id','recording');byvideo={};channels={};reverse={};rows=[];mapping={}
 for r in snapshot['records']:byvideo.setdefault(r['video_id'],[]).append(r)
 for vid,rec in recs.items():
  allrows=byvideo.get(vid,[])
  if any(r['merged_into'] is None and r['label_type']!='triage' for r in allrows):raise fl.FineLabelContractError('Unsupported surviving saved label type cannot define a complete whole review')
  review=[r for r in allrows if r['label_type']=='triage' and r['merged_into'] is None]
  if not review:raise fl.FineLabelContractError('Whole target requires a nonempty saved recording review')
  for r in allrows:
   timestamp(r.get('analyzed_at'))
   if r['analyzed_at']!=rec['analyzed_at']:raise fl.FineLabelContractError('Whole review analysis generation mismatch')
  canonical={channel_key(r['channel']) for r in allrows}
  if len(canonical)!=1 or not next(iter(canonical)):raise fl.FineLabelContractError('Whole recording channel identity mismatch')
  channel=next(iter(canonical));group=rec['group']
  if channels.get(group,channel)!=channel or reverse.get(channel,group)!=group:raise fl.FineLabelContractError('Whole private channel mapping is not one-to-one')
  channels[group]=channel;reverse[channel]=group
  original={r['clip_id']:r for r in allrows if not r['added']}
  if len(original)!=sum(not r['added'] for r in allrows):raise fl.FineLabelContractError('Duplicate original proposal identity')
  proposals=unique(rec['original_proposals'],'id','original proposal')
  if set(proposals)!=set(original):raise fl.FineLabelContractError('Whole saved-review proposal universe mismatch')
  for key,r in original.items():
   a=r['detected_start'] if r['detected_start'] is not None else r['start_seconds'];b=r['detected_end'] if r['detected_end'] is not None else r['end_seconds']
   if abs(proposals[key]['start']-a)>.001 or abs(proposals[key]['end']-b)>.001:raise fl.FineLabelContractError('Whole original proposal provenance mismatch')
  if any(r['verdict'] not in ('keep','skip') for r in review):raise fl.FineLabelContractError('Unknown saved proposal verdict')
  kept=[r for r in review if r['verdict']=='keep'];explicit=any('keep_whole' in r['reasons'] for r in kept);allskip=all(r['verdict']=='skip' for r in review)
  if bool(rec['any_keep'])!=bool(kept) or bool(rec['explicit_whole'])!=explicit:raise fl.FineLabelContractError('Frozen whole/current recording flags disagree with saved review')
  y=1 if explicit else (0 if allskip else None);reason='explicit_keep_whole' if y==1 else ('saved_all_proposals_skipped' if y==0 else 'mixed_edited_clips_unknown')
  nearfull=bool(y is None and rec['kept_coverage']>=.95)
  alias=f'w{len(rows):03d}';rows.append({'row':alias,'group':group,'generation':hashlib.sha256(rec['analyzed_at'].encode()).hexdigest()[:24],'y':y,'label_target':SEMANTICS['target'],'label_policy':POLICY,'reason':reason,'saved_proposals':len(review),'original_proposals':len(original),'near_full_edited_clips_still_unknown':nearfull,'future_replacement_y':None,'permanent_storage_y':None})
  mapping[alias]={'video_id':vid,'analyzed_at':rec['analyzed_at'],'channel':channel,'feedback_ids':[r['id'] for r in review],'original_clip_ids':list(original)}
 known=[r for r in rows if r['y'] is not None];positive=[r for r in known if r['y']==1];negative=[r for r in known if r['y']==0];unknown=[r for r in rows if r['y'] is None]
 counts={'recordings':len(rows),'known':len(known),'positive':len(positive),'negative':len(negative),'unknown':len(unknown),'known_channels':len({r['group'] for r in known}),'positive_channels':len({r['group'] for r in positive}),'negative_channels':len({r['group'] for r in negative}),'near_full_unknown':sum(r['near_full_edited_clips_still_unknown'] for r in unknown),'near_full_unknown_channels':len({r['group'] for r in unknown if r['near_full_edited_clips_still_unknown']})}
 feasible=len(positive)>=5 and len(negative)>=5
 private={'policy':POLICY,'recordings':mapping,'scope':'Private saved-review generation binding only; no source media paths'}
 receipt={'schema_version':1,'policy':POLICY,'target':SEMANTICS['target'],'semantics_sha256':digest(SEMANTICS),'private_binding_sha256':digest(private),'counts':counts,'rows':rows,'feasibility':{'status':'minimum_class_counts_met_not_validated' if feasible else 'insufficient_explicit_whole_positives','minimum_positive_recordings':5,'minimum_negative_recordings':5,'class_count_gate_passed':feasible,'positive_channels':counts['positive_channels'],'limitation':('Only '+str(counts['positive_channels'])+' observed positive channels; holding a remaining positive channel out can create zero-positive inner training folds. No classifier was fitted.' if counts['positive_channels']<=2 else 'Class counts alone do not validate unseen-channel acceptance. No classifier was fitted.')},'model_fit_count':0,'enabled':False,'automatic_action':False,'historical_coverage_proxy_results':'Preserved as historical invalid-target diagnostics; never current training labels','coverage_proxy_enabled':False}
 return receipt,private


def export(root,out):
 paths=[root/'cohort.json',root/'private_snapshot.json'];before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths};receipt,private=build(json.loads(paths[0].read_text()),json.loads(paths[1].read_text()))
 if (receipt['counts']['recordings'],receipt['counts']['positive'],receipt['counts']['negative'],receipt['counts']['unknown'],receipt['counts']['near_full_unknown'])!=(138,3,39,96,14):raise fl.FineLabelContractError('Confirmed138/3/39/96/14 eligibility count mismatch')
 for p in paths:
  if hashlib.sha256(p.read_bytes()).hexdigest()!=before[p.name]:raise fl.FineLabelContractError('Frozen whole sources changed during export')
 receipt['source_sha256']=before
 immutable_write(out/f'semantics.{POLICY}.json',SEMANTICS);immutable_write(out/f'private-identity.{POLICY}.json',private);immutable_write(out/f'eligibility.{POLICY}.json',receipt)
 print(json.dumps({'policy':POLICY,'counts':receipt['counts'],'feasibility':receipt['feasibility'],'model_fit_count':0,'enabled':False,'output':str(out)}));return receipt

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();export(a.root,a.output)
