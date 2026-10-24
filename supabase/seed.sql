-- SAMPLE venues for the prototype. Names, prices and details are illustrative,
-- not verified listings. The API labels every suggestion "Sample suggestion".
insert into public.venues (name, area, activity_types, tags, price_per_person, details) values
  ('Indiranagar Rooftop Grill',      'Indiranagar',     '{dinner,drinks}',          '{north-indian,grill,rooftop,non-veg,veg}', 1400, 'Rooftop seating, good for groups of 4-10'),
  ('12th Main Coffee Room',          'Indiranagar',     '{coffee,brunch}',          '{cafe,quiet,veg,desserts}',                 450, 'Quiet cafe with long tables'),
  ('Koramangala Dosa Corner',        'Koramangala',     '{dinner,brunch}',          '{south-indian,veg,budget}',                 300, 'Casual, fast service'),
  ('Koramangala Board Game Cafe',    'Koramangala',     '{activity,coffee}',        '{board-games,cafe,veg,snacks}',             600, 'Games library, table booking recommended'),
  ('HSR Craft Brew House',           'HSR Layout',      '{dinner,drinks}',          '{brewery,continental,non-veg,veg,live-music}', 1600, 'Microbrewery with large tables'),
  ('HSR Green Bowl',                 'HSR Layout',      '{dinner,brunch,coffee}',   '{healthy,salads,vegan,veg}',                550, 'Healthy bowls and smoothies'),
  ('Whitefield Biryani Hall',        'Whitefield',      '{dinner}',                 '{biryani,hyderabadi,non-veg,veg}',          700, 'Family seating'),
  ('Whitefield Bowling Arena',       'Whitefield',      '{activity}',               '{bowling,arcade,snacks}',                   900, 'Bowling lanes and arcade'),
  ('Brookefield Chai Point Hub',     'Brookefield',     '{coffee}',                 '{chai,snacks,veg,budget}',                  200, 'Quick catch-up spot'),
  ('Brookefield Pan-Asian Kitchen',  'Brookefield',     '{dinner}',                 '{asian,chinese,thai,non-veg,veg}',         1100, 'Pan-Asian menu'),
  ('MG Road Heritage Bistro',        'MG Road',         '{dinner,brunch,drinks}',   '{continental,european,non-veg,veg}',       1800, 'Central, easy metro access'),
  ('Cubbon Park Picnic Meetup',      'MG Road',         '{activity}',               '{outdoors,park,free,walk}',                   0, 'Outdoor; weather dependent'),
  ('Jayanagar Tiffin Room',          'Jayanagar',       '{brunch,dinner,coffee}',   '{south-indian,veg,budget,filter-coffee}',   250, 'Classic tiffin and filter coffee'),
  ('JP Nagar Pottery Studio',        'JP Nagar',        '{activity}',               '{pottery,workshop,creative}',              1200, 'Group pottery session'),
  ('Electronic City Food Court',     'Electronic City', '{dinner,coffee}',          '{multi-cuisine,budget,veg,non-veg}',        400, 'Many options for mixed preferences');
