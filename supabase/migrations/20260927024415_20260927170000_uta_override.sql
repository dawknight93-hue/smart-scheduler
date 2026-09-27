/*
# UTA override for single sessions

Family (and desk/home/errand) items are kept off UTA days. When you drag one
onto a UTA day a second time and confirm, that item gets uta_override = true so
the scheduler keeps it there instead of pushing it off again.
*/

ALTER TABLE habits ADD COLUMN IF NOT EXISTS uta_override boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS uta_override boolean NOT NULL DEFAULT false;