// Pin the locale so a developer shell (e.g. LANG=es_AR.UTF-8) cannot change test output.
process.env.LANG = "C";
delete process.env.LC_ALL;
delete process.env.LC_MESSAGES;
delete process.env.MNEMO_LOCALE;
