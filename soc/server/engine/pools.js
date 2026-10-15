// Name pools for per-attempt renaming (Build specification, section 6.2).
// Every external name is invented: domains use the reserved example TLDs
// (RFC 2606) and addresses come from 198.18.0.0/15, a range reserved for
// benchmarking that is never routed on the internet.

export const FIRST_NAMES = [
  'Aaron', 'Abigail', 'Adele', 'Aditi', 'Ahmed', 'Aiko', 'Alana', 'Alberto', 'Alicia', 'Amara', 'Amir', 'Ana', 'Anders', 'Andrea', 'Anika', 'Arjun', 'Astrid', 'Ayesha',
  'Beatriz', 'Benedikt', 'Bianca', 'Bilal', 'Bruno', 'Camila', 'Carlos', 'Cecile', 'Chen', 'Chiara', 'Chloe', 'Claudia', 'Dalia', 'Damien', 'Dana', 'Daria', 'David',
  'Deepa', 'Diego', 'Dimitri', 'Elif', 'Elias', 'Elisa', 'Emeka', 'Emil', 'Erik', 'Esther', 'Fatima', 'Felix', 'Femi', 'Fiona', 'Florian', 'Gabriel', 'Gemma', 'Gita',
  'Grace', 'Hamza', 'Hana', 'Hector', 'Helena', 'Hiro', 'Ibrahim', 'Ida', 'Ilse', 'Imran', 'Ines', 'Irina', 'Isaac', 'Ivan', 'Jade', 'Jakob', 'Jamal', 'Jana', 'Javier',
  'Jonas', 'Joao', 'Julia', 'Kai', 'Karim', 'Kasia', 'Kavya', 'Keira', 'Kofi', 'Laila', 'Lars', 'Laura', 'Leila', 'Leon', 'Lina', 'Lucas', 'Lucia', 'Luka', 'Maeve',
  'Mahmoud', 'Maja', 'Malik', 'Marco', 'Maria', 'Mateo', 'Maya', 'Mei', 'Mila', 'Milan', 'Mina', 'Nadia', 'Naveen', 'Neha', 'Nikolai', 'Nina', 'Noah', 'Olga', 'Omar',
  'Oscar', 'Paula', 'Pavel', 'Petra', 'Pieter', 'Quentin', 'Rafael', 'Rania', 'Ravi', 'Rhea', 'Rohan', 'Ruth', 'Saanvi', 'Sami', 'Sana', 'Sara', 'Selin', 'Shreya',
  'Simone', 'Stefan', 'Suki', 'Tariq', 'Tessa', 'Theo', 'Tomas', 'Uma', 'Valentina', 'Vera', 'Vikram', 'Wanjiru', 'Wei', 'Yara', 'Yusuf', 'Zainab', 'Zoe',
];

export const SURNAMES = [
  'Abara', 'Acosta', 'Adler', 'Agarwal', 'Ahlberg', 'Alvarez', 'Amato', 'Andersen', 'Antonelli', 'Arslan', 'Asante', 'Bakker', 'Banerjee', 'Barros', 'Becker', 'Bergstrom',
  'Bianchi', 'Bose', 'Brennan', 'Brooks', 'Calder', 'Campos', 'Carvalho', 'Chandra', 'Chua', 'Costa', 'Dahl', 'Dalton', 'Das', 'De Vries', 'Delacroix', 'Dimitrov',
  'Dossou', 'Draper', 'Duarte', 'Eklund', 'Ellis', 'Engel', 'Esposito', 'Farah', 'Ferreira', 'Fischer', 'Fontaine', 'Fraser', 'Garcia', 'Gill', 'Grant', 'Greco',
  'Gupta', 'Haas', 'Halvorsen', 'Hartmann', 'Hayes', 'Holm', 'Hussain', 'Ibarra', 'Iyer', 'Jansen', 'Jensen', 'Joshi', 'Kamau', 'Kapoor', 'Karlsson', 'Kaur', 'Keller',
  'Kim', 'Koenig', 'Kowalski', 'Kruger', 'Laine', 'Larsen', 'Lehmann', 'Lim', 'Lindgren', 'Lopes', 'Lund', 'Mahler', 'Malik', 'Mancini', 'Marsh', 'Mehta', 'Meyer',
  'Molina', 'Moreau', 'Mwangi', 'Nakamura', 'Navarro', 'Neumann', 'Nielsen', 'Novak', 'Nyberg', 'Oduya', 'Okoro', 'Olsen', 'Ortega', 'Osei', 'Park', 'Patel',
  'Pereira', 'Petersen', 'Pillai', 'Quinn', 'Rahman', 'Rao', 'Reyes', 'Richter', 'Rinaldi', 'Rojas', 'Rossi', 'Sato', 'Schmidt', 'Sen', 'Serrano', 'Shah', 'Silva',
  'Singh', 'Soto', 'Strand', 'Suzuki', 'Tanaka', 'Thakur', 'Torres', 'Tran', 'Ueda', 'Valdez', 'Varga', 'Vasquez', 'Verma', 'Vogel', 'Wagner', 'Walsh', 'Weber',
  'Winter', 'Wolff', 'Yadav', 'Yilmaz', 'Young', 'Zamora', 'Zhang', 'Ziegler',
];

export const DOMAIN_WORDS = [
  'amber', 'anchor', 'arc', 'atlas', 'beacon', 'birch', 'blue', 'bridge', 'brook', 'canyon', 'cargo', 'cedar', 'cinder', 'cloud', 'coast', 'cobalt', 'comet', 'copper',
  'core', 'crest', 'delta', 'drift', 'echo', 'ember', 'field', 'flint', 'forge', 'frost', 'gate', 'glade', 'granite', 'grid', 'harbor', 'haven', 'hollow', 'iron', 'ivory',
  'jade', 'juniper', 'keystone', 'lantern', 'ledger', 'linden', 'lumen', 'maple', 'meadow', 'mesa', 'nimbus', 'north', 'nova', 'oak', 'onyx', 'orbit', 'parcel',
  'pine', 'pixel', 'prism', 'quarry', 'quill', 'raven', 'reef', 'ridge', 'river', 'sable', 'sage', 'signal', 'slate', 'spruce', 'stone', 'summit', 'swift', 'tide',
  'timber', 'trail', 'vale', 'vector', 'vertex', 'willow', 'zenith', 'sync', 'docs', 'portal', 'relay', 'metric', 'secure', 'update', 'share', 'files', 'mail', 'invoice',
];
export const DOMAIN_TLDS = ['example', 'example.com', 'example.net', 'example.org'];

// Words that must never appear in a generated domain, so an invented name
// can never be read as a real brand.
export const BRAND_BLOCKLIST = [
  'microsoft', 'office', 'outlook', 'azure', 'google', 'gmail', 'amazon', 'aws', 'apple', 'icloud', 'paypal', 'bank', 'chase', 'hsbc', 'barclays', 'citi', 'visa',
  'mastercard', 'dropbox', 'box', 'github', 'gitlab', 'okta', 'cisco', 'fortinet', 'paloalto', 'crowdstrike', 'sentinel', 'meta', 'facebook', 'instagram', 'linkedin',
  'twitter', 'netflix', 'adobe', 'oracle', 'salesforce', 'slack', 'zoom', 'dhl', 'fedex', 'ups', 'maersk', 'docusign', 'yahoo', 'cloudflare', 'akamai',
];

// 40 /24 blocks inside 198.18.0.0/15.
export const EXTERNAL_BLOCKS = Array.from({ length: 40 }, (_, i) => (i < 20 ? `198.18.${16 + i * 7}` : `198.19.${9 + (i - 20) * 11}`));
