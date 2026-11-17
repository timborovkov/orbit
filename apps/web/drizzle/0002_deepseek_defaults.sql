-- Replace the original starter models, preserving administrator-customized defaults.
UPDATE templates
SET config = jsonb_set(jsonb_set(config,
  '{mainModel}', CASE WHEN config->>'mainModel' = 'openai/gpt-4.1-mini'
    THEN '"deepseek/deepseek-v4.1-flash-1017"'::jsonb ELSE config->'mainModel' END),
  '{evaluatorModel}', CASE WHEN config->>'evaluatorModel' = 'openai/gpt-4.1-nano'
    THEN '"deepseek/deepseek-v4.1-flash-1017"'::jsonb ELSE config->'evaluatorModel' END),
  revision = revision + 1
WHERE config->>'mainModel' = 'openai/gpt-4.1-mini'
   OR config->>'evaluatorModel' = 'openai/gpt-4.1-nano';
