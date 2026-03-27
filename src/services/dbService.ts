/**
 * Database boundary — all Supabase I/O for HTTP routes flows through lib/db.
 * Routes should import from here (or this module’s exports) for a clear service layer.
 */
export * from "../lib/db";
