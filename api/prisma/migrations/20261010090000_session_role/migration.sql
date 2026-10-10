-- The role a session was issued for; a change of role ends the user's sessions
ALTER TABLE "sessions" ADD COLUMN "role" TEXT;
