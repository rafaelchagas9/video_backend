"""Migration checks. PostgreSQL mode touches ONLY a session-local temporary table.

RUN_DISPOSABLE_PG=1 explicitly enables those two tests; no production migration is applied.
"""
import copy,json,os,re,unittest
from pathlib import Path
import targeted_label_round as base
ROOT=base.BACKEND/'src/database/drizzle-migrations'
SQL=(ROOT/'0058_connected_versus_identity.sql').read_text()
STATEMENTS=[part.strip() for part in SQL.split('--> statement-breakpoint') if part.strip()]

class Static(unittest.TestCase):
 def test_snapshot_has_only_identity_index_changes(self):
  old=json.loads((ROOT/'meta/0057_snapshot.json').read_text());new=json.loads((ROOT/'meta/0058_snapshot.json').read_text());self.assertEqual(new['prevId'],old['id'])
  before=old['tables']['public.recording_label_tasks']['indexes'];after=new['tables']['public.recording_label_tasks']['indexes']
  self.assertEqual(set(after),{'recording_label_tasks_versus_position','recording_label_tasks_nonversus_item'})
  self.assertEqual([c['expression'] for c in after['recording_label_tasks_versus_position']['columns']],['kind','batch','position'])
  self.assertEqual([c['expression'] for c in after['recording_label_tasks_nonversus_item']['columns']],['kind','batch','video_id','start_seconds'])
  self.assertIn("= 'versus'",after['recording_label_tasks_versus_position']['where']);self.assertIn("<> 'versus'",after['recording_label_tasks_nonversus_item']['where'])
  a=copy.deepcopy(old);b=copy.deepcopy(new)
  for value in (a,b):value.pop('id');value.pop('prevId');value['tables']['public.recording_label_tasks'].pop('indexes')
  self.assertEqual(a,b)
  journal=json.loads((ROOT/'meta/_journal.json').read_text());self.assertEqual(journal['entries'][-1]['tag'],'0058_connected_versus_identity')
 def test_replacements_created_before_original_removed(self):
  self.assertEqual(len(STATEMENTS),3);self.assertIn('CREATE UNIQUE INDEX "recording_label_tasks_versus_position"',STATEMENTS[0]);self.assertIn('CREATE UNIQUE INDEX "recording_label_tasks_nonversus_item"',STATEMENTS[1]);self.assertEqual(STATEMENTS[2],'DROP INDEX "recording_label_tasks_item";')

@unittest.skipUnless(os.environ.get('RUN_DISPOSABLE_PG')=='1','Explicit disposable PostgreSQL fixture opt-in required')
class PostgreSQL(unittest.TestCase):
 def setUp(self):
  import psycopg
  self.pg=psycopg;self.connection=psycopg.connect(base.pg_config(),autocommit=True)
  self.connection.execute("SET statement_timeout='5s'");self.connection.execute('SET search_path=pg_temp')
  self.connection.execute('CREATE TEMP TABLE recording_label_tasks(id serial PRIMARY KEY,kind text NOT NULL,batch text NOT NULL,video_id integer NOT NULL,start_seconds double precision NOT NULL,position integer NOT NULL,answer text)')
  self.assertTrue(self.connection.execute("SELECT 'recording_label_tasks'::regclass::oid=(SELECT oid FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname='recording_label_tasks')").fetchone()[0])
  self.connection.execute('CREATE UNIQUE INDEX recording_label_tasks_item ON recording_label_tasks(kind,batch,video_id,start_seconds)')
 def tearDown(self):self.connection.close()
 def insert(self,kind,vid,start,position,answer=None):
  self.connection.execute('INSERT INTO recording_label_tasks(kind,batch,video_id,start_seconds,position,answer) VALUES(%s,%s,%s,%s,%s,%s)',(kind,'fixture',vid,start,position,answer))
 def migrate(self):
  with self.connection.transaction():
   for statement in STATEMENTS:self.connection.execute(statement)
 def test_connected_anchor_reuse_and_nonversus_identity_preserved(self):
  self.insert('versus',1,0,0,'both');self.insert('recall-audit',2,10,0,'keep');self.insert('refine',3,20,0,'save');before=self.connection.execute('SELECT id,answer FROM recording_label_tasks ORDER BY id').fetchall();self.migrate()
  self.assertEqual(before,self.connection.execute('SELECT id,answer FROM recording_label_tasks ORDER BY id').fetchall())
  self.insert('versus',1,0,1)
  with self.assertRaises(self.pg.errors.UniqueViolation):self.insert('versus',4,50,1)
  for kind,vid,start in [('recall-audit',2,10),('refine',3,20)]:
   with self.assertRaises(self.pg.errors.UniqueViolation):self.insert(kind,vid,start,8)
   self.insert(kind,vid+10,start,0)
  self.assertEqual(self.connection.execute('SELECT answer FROM recording_label_tasks WHERE id=1').fetchone()[0],'both')
 def test_duplicate_existing_positions_roll_back_without_losing_original_index(self):
  self.insert('versus',1,0,0,'a');self.insert('versus',2,10,0,'b')
  with self.assertRaises(self.pg.errors.UniqueViolation):self.migrate()
  indexes=self.connection.execute('SELECT indexname FROM pg_indexes WHERE schemaname=(SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()) AND tablename=%s',('recording_label_tasks',)).fetchall();names={row[0] for row in indexes}
  self.assertIn('recording_label_tasks_item',names);self.assertNotIn('recording_label_tasks_versus_position',names);self.assertNotIn('recording_label_tasks_nonversus_item',names)
  with self.assertRaises(self.pg.errors.UniqueViolation):self.insert('versus',1,0,4)
  self.assertEqual(self.connection.execute('SELECT answer FROM recording_label_tasks ORDER BY id').fetchall(),[('a',),('b',)])

if __name__=='__main__':unittest.main()
