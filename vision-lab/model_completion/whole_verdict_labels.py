"""Explicit whole-retention task outcomes; separate from legacy clip/fine label collectors."""
from __future__ import annotations
import copy,datetime,math
POLICY='whole-recording-explicit-task-v1'
TARGET='current_whole_recording_review'
ANSWERS={'keep_entire':1,'edited_parts_only':0,'nothing_worth_keeping':0,'unsure':None}

def metadata(task,reserved):
 if task.get('kind')!='whole-verdict':raise ValueError('Explicit whole task kind required')
 c=task.get('context') or {}
 if c.get('target')!=TARGET or c.get('reserved_fine_holdout') is not False or c.get('fine_data_role')!='training':raise ValueError('Training-only explicit whole target required')
 source=c.get('candidate') or {};group=source.get('channel_key');duration=source.get('duration_seconds')
 if not isinstance(group,str) or not group or group in reserved:raise ValueError('Reserved or unknown whole creator')
 if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or duration<=0 or c.get('original_range')!=[0,duration] or task.get('start_seconds')!=0 or task.get('end_seconds')!=duration:raise ValueError('Exact entire recording required')
 if isinstance(source.get('video_id'),bool) or not isinstance(source.get('video_id'),int) or source['video_id']<=0 or task.get('video_id')!=source['video_id']:raise ValueError('Exact recording identity required')
 at=source.get('analyzed_at')
 try:datetime.datetime.fromisoformat(at.replace('Z','+00:00'))
 except (ValueError,AttributeError,TypeError) as e:raise ValueError('Frozen recording analysis generation required') from e
 if not isinstance(source.get('index'),dict) or not isinstance(source.get('source_fingerprint'),dict) or not source['index'] or not source['source_fingerprint']:raise ValueError('Exact numeric generation/source receipts required')
 if c.get('cut_target') is not None or c.get('acceptability_target') is not None:raise ValueError('No clip or cut target inferred')
 return source

def contract(task,reserved):
 source=metadata(task,reserved);answer=task.get('answer');detail=task.get('detail');reasons=task.get('reasons',[])
 if detail is not None or reasons:raise ValueError('Whole decisions cannot carry clip/cut/viewing detail')
 if answer is None:
  if task.get('answered_at') is not None:raise ValueError('Pending whole task has stale timestamp')
  return None
 if answer not in ANSWERS:raise ValueError('Unknown whole-retention outcome')
 at=task.get('answered_at')
 try:datetime.datetime.fromisoformat(at.replace('Z','+00:00'))
 except (ValueError,AttributeError,TypeError) as e:raise ValueError('Explicit human answer timestamp required') from e
 return {'task_id':task['id'],'batch':task['batch'],'position':task['position'],'kind':'whole-verdict','group':source['channel_key'],'video_id':source['video_id'],'analyzed_at':source['analyzed_at'],'source_fingerprint':copy.deepcopy(source['source_fingerprint']),'index':copy.deepcopy(source['index']),'duration_seconds':source['duration_seconds'],'label_policy':POLICY,'label_target':TARGET,'answer':answer,'y':ANSWERS[answer],'answered_at':at,'authority':'explicit_current_whole_retention_choice','interpretation':'Current decision to retain the entire recording as-is. Edited-parts-only does not label excluded frames bad or deny that the unedited recording might be acceptable in another context.','reserved_fine_holdout':False,'fine_data_role':'training','clip_current_acceptability_y':None,'cut_gold':None,'future_replacement_y':None,'permanent_storage_y':None}
