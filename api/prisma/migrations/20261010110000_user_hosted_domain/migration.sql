-- The Google Workspace domain of an account (the hd claim). A bank officer by
-- domain must have it; a consumer account made with a work address does not.
ALTER TABLE "users" ADD COLUMN "hosted_domain" TEXT;
