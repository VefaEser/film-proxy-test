-- 0047_story_dimensions_remove_concept.sql
-- Eski filtre açıklamasındaki konsept tanımını kaldırır.

UPDATE app_config
SET value = REPLACE(
    REPLACE(
      REPLACE(value, ', concept', ''),
      'concept, ',
      ''
    ),
    '- concept: Konsept filmi.' || char(10),
    ''
)
WHERE key = 'filter_info.story_dimensions';
