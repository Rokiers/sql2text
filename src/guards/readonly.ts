const FORBIDDEN_PATTERNS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bTRUNCATE\b/i,
  /\bREPLACE\b/i,
  /\bLOAD\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bFLUSH\b/i,
  /\bKILL\b/i,
  /\bRENAME\b/i,
  /\bLOCK\b/i,
  /\bUNLOCK\b/i,
  /\bCALL\b/i,
  /\bEXECUTE\b/i,
  /\bPREPARE\b/i,
  /\bDEALLOCATE\b/i,
  /\bINSTALL\b/i,
  /\bUNINSTALL\b/i,
  /\bRESET\b/i,
  /\bPURGE\b/i,
  /\bHANDLER\b/i,
  /\bIMPORT\b/i,
  /\bANALYZE\b/i,
  /\bCHECK\b/i,
  /\bCHECKSUM\b/i,
  /\bOPTIMIZE\b/i,
  /\bREPAIR\b/i,
  /\bCACHE\b/i,
  /\bBACKUP\b/i,
  /\bRESTORE\b/i,
];

const ALLOWED_PATTERNS = [
  /^\s*SELECT\b/i,
  /^\s*SHOW\b/i,
  /^\s*DESCRIBE\b/i,
  /^\s*DESC\b/i,
  /^\s*EXPLAIN\b/i,
  /^\s*USE\b/i,
  /^\s*SET\b/i,
  /^\s*WITH\b/i, // CTE queries
];

export function validateSql(sql: string): { valid: boolean; reason?: string } {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { valid: false, reason: "Empty SQL statement is not allowed" };
  }

  // Check for forbidden patterns first (these could be nested in legal-looking queries)
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        reason: `SQL contains forbidden keyword matching: ${pattern.source}`,
      };
    }
  }

  // Must match an allowed pattern
  const isAllowed = ALLOWED_PATTERNS.some((p) => p.test(trimmed));
  if (!isAllowed) {
    return {
      valid: false,
      reason:
        "Only SELECT, SHOW, DESCRIBE, EXPLAIN, USE, SET, and WITH statements are allowed for read-only access",
    };
  }

  // Block multiple statements (semicolon injection)
  // Allow semicolons inside strings or comments, but block multiple statements
  const cleanSql = removeStringLiterals(trimmed);
  if (cleanSql.includes(";")) {
    // Check if there are multiple statements (not just trailing semicolon)
    const statements = cleanSql.split(";").filter((s) => s.trim());
    if (statements.length > 1) {
      return {
        valid: false,
        reason: "Multiple SQL statements are not allowed",
      };
    }
  }

  return { valid: true };
}

function removeStringLiterals(sql: string): string {
  let result = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "\\" && (inSingleQuote || inDoubleQuote)) {
      result += " ";
      i += 2;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      result += " ";
      i++;
      continue;
    }

    if (ch === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      result += " ";
      i++;
      continue;
    }

    if (ch === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      result += " ";
      i++;
      continue;
    }

    result += inSingleQuote || inDoubleQuote || inBacktick ? " " : ch;
    i++;
  }

  return result;
}
