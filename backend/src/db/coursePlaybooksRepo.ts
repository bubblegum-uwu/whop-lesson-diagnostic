import type { Pool, PoolClient } from "pg";
import type { CoreFramework, CoursePlaybookDocument, DecisionFramework } from "../synthesis/schema.js";

export type Queryable = Pool | PoolClient;

export interface CoursePlaybookRow {
  playbookId: number;
  runId: string;
  title: string;
  coreFramework: CoreFramework;
  playbook: CoursePlaybookDocument;
  decisionFramework: DecisionFramework;
  createdAt: Date;
}

interface Row {
  playbook_id: string;
  run_id: string;
  title: string;
  core_framework_json: CoreFramework;
  playbook_json: CoursePlaybookDocument;
  decision_framework_json: DecisionFramework;
  created_at: Date;
}

function mapRow(row: Row): CoursePlaybookRow {
  return {
    playbookId: Number(row.playbook_id),
    runId: row.run_id,
    title: row.title,
    coreFramework: row.core_framework_json,
    playbook: row.playbook_json,
    decisionFramework: row.decision_framework_json,
    createdAt: row.created_at,
  };
}

const COLUMNS = `playbook_id, run_id, title, core_framework_json, playbook_json, decision_framework_json, created_at`;

export interface CreateCoursePlaybookInput {
  runId: string;
  title: string;
  coreFramework: CoreFramework;
  playbook: CoursePlaybookDocument;
  decisionFramework: DecisionFramework;
}

export async function createCoursePlaybook(db: Queryable, input: CreateCoursePlaybookInput): Promise<CoursePlaybookRow> {
  const result = await db.query(
    `INSERT INTO course_playbooks (run_id, title, core_framework_json, playbook_json, decision_framework_json)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [input.runId, input.title, JSON.stringify(input.coreFramework), JSON.stringify(input.playbook), JSON.stringify(input.decisionFramework)],
  );
  return mapRow(result.rows[0] as Row);
}

export async function getCoursePlaybookByRun(db: Queryable, runId: string): Promise<CoursePlaybookRow | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM course_playbooks WHERE run_id = $1`, [runId]);
  return result.rows[0] ? mapRow(result.rows[0] as Row) : null;
}
