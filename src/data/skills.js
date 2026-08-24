'use strict';

// Skills database across 10 categories (200+ skills)
//
// `name` is the MATCHING key: lowercase, because both the CV and the job
// description are lowercased before any regex runs (services/scorer.js). It is
// machinery and must never reach a reader.
//
// `display` is the surface form to PRINT — the spelling the technology itself
// uses ('gRPC', 'Node.js', 'PostgreSQL', 'CI/CD'). It exists because the
// narrative layer was rendering the matching key straight into a candidate's
// PDF: "the CV does not document kubernetes, terraform and aws". Deriving it by
// transform is not possible — title case yields "Aws", "Grpc", "Nodejs" — so
// each form is stated, not computed.
//
// `display` is OPTIONAL and deliberately absent on two kinds of entry:
//   - common nouns and phrases already correct in lowercase mid-sentence
//     ('microservices', 'machine learning', 'unit testing', 'accessibility')
//   - names whose canonical form is genuinely lowercase ('pandas',
//     'scikit-learn', 'pytest')
// Absent means "print the key unchanged", which narrativeGenerator.displayForm()
// does. A guessed capitalisation would be worse than a lowercase one: it looks
// deliberate and is wrong.
//
// SKILLS_VOCABULARY_VERSION is an INPUT to rendered prose, so it is versioned
// like the band thresholds and the template catalogue, and stamped into the PDF
// provenance footer. Editing any `display` value below changes the wording of
// every report that names that skill, including reports regenerated from old
// records — bump it in the same commit.
const SKILLS_DB = [
  // Programming Languages
  { name: 'python', display: 'Python', category: 'Programming' },
  { name: 'javascript', display: 'JavaScript', category: 'Programming' },
  { name: 'typescript', display: 'TypeScript', category: 'Programming' },
  { name: 'java', display: 'Java', category: 'Programming' },
  { name: 'c++', display: 'C++', category: 'Programming' },
  { name: 'c#', display: 'C#', category: 'Programming' },
  { name: 'go', display: 'Go', category: 'Programming' },
  { name: 'golang', display: 'Go', category: 'Programming' },
  { name: 'rust', display: 'Rust', category: 'Programming' },
  { name: 'ruby', display: 'Ruby', category: 'Programming' },
  { name: 'php', display: 'PHP', category: 'Programming' },
  { name: 'swift', display: 'Swift', category: 'Programming' },
  { name: 'kotlin', display: 'Kotlin', category: 'Programming' },
  { name: 'scala', display: 'Scala', category: 'Programming' },
  { name: 'r', display: 'R', category: 'Programming' },
  { name: 'bash', display: 'Bash', category: 'Programming' },
  { name: 'sql', display: 'SQL', category: 'Programming' },
  { name: 'perl', display: 'Perl', category: 'Programming' },
  { name: 'matlab', display: 'MATLAB', category: 'Programming' },
  { name: 'c', display: 'C', category: 'Programming' },

  // Web / Frontend
  { name: 'react', display: 'React', category: 'Web/Frontend' },
  { name: 'angular', display: 'Angular', category: 'Web/Frontend' },
  { name: 'vue', display: 'Vue', category: 'Web/Frontend' },
  { name: 'next.js', display: 'Next.js', category: 'Web/Frontend' },
  { name: 'svelte', display: 'Svelte', category: 'Web/Frontend' },
  { name: 'html', display: 'HTML', category: 'Web/Frontend' },
  { name: 'css', display: 'CSS', category: 'Web/Frontend' },
  { name: 'tailwind', display: 'Tailwind', category: 'Web/Frontend' },
  { name: 'graphql', display: 'GraphQL', category: 'Web/Frontend' },
  { name: 'rest api', display: 'REST API', category: 'Web/Frontend' },
  { name: 'redux', display: 'Redux', category: 'Web/Frontend' },
  { name: 'webpack', display: 'Webpack', category: 'Web/Frontend' },
  { name: 'sass', display: 'Sass', category: 'Web/Frontend' },
  { name: 'bootstrap', display: 'Bootstrap', category: 'Web/Frontend' },
  { name: 'jquery', display: 'jQuery', category: 'Web/Frontend' },
  { name: 'vite', display: 'Vite', category: 'Web/Frontend' },
  { name: 'nuxt', display: 'Nuxt', category: 'Web/Frontend' },

  // Backend
  { name: 'node.js', display: 'Node.js', category: 'Backend' },
  { name: 'django', display: 'Django', category: 'Backend' },
  { name: 'flask', display: 'Flask', category: 'Backend' },
  { name: 'fastapi', display: 'FastAPI', category: 'Backend' },
  { name: 'spring', display: 'Spring', category: 'Backend' },
  { name: 'express', display: 'Express', category: 'Backend' },
  { name: 'microservices', category: 'Backend' },
  { name: 'kafka', display: 'Kafka', category: 'Backend' },
  { name: 'rabbitmq', display: 'RabbitMQ', category: 'Backend' },
  { name: 'grpc', display: 'gRPC', category: 'Backend' },
  { name: 'laravel', display: 'Laravel', category: 'Backend' },
  { name: 'rails', display: 'Rails', category: 'Backend' },
  { name: 'nestjs', display: 'NestJS', category: 'Backend' },
  { name: 'fastify', display: 'Fastify', category: 'Backend' },
  { name: 'graphql api', display: 'GraphQL API', category: 'Backend' },
  { name: 'rest', display: 'REST', category: 'Backend' },
  { name: 'api design', display: 'API design', category: 'Backend' },
  { name: 'websockets', display: 'WebSockets', category: 'Backend' },

  // Data & AI
  { name: 'machine learning', category: 'Data & AI' },
  { name: 'deep learning', category: 'Data & AI' },
  { name: 'tensorflow', display: 'TensorFlow', category: 'Data & AI' },
  { name: 'pytorch', display: 'PyTorch', category: 'Data & AI' },
  { name: 'scikit-learn', category: 'Data & AI' },
  { name: 'pandas', category: 'Data & AI' },
  { name: 'spark', display: 'Spark', category: 'Data & AI' },
  { name: 'data analysis', category: 'Data & AI' },
  { name: 'nlp', display: 'NLP', category: 'Data & AI' },
  { name: 'llm', display: 'LLM', category: 'Data & AI' },
  { name: 'power bi', display: 'Power BI', category: 'Data & AI' },
  { name: 'tableau', display: 'Tableau', category: 'Data & AI' },
  { name: 'etl', display: 'ETL', category: 'Data & AI' },
  { name: 'numpy', display: 'NumPy', category: 'Data & AI' },
  { name: 'data science', category: 'Data & AI' },
  { name: 'computer vision', category: 'Data & AI' },
  { name: 'statistics', category: 'Data & AI' },
  { name: 'data engineering', category: 'Data & AI' },
  { name: 'feature engineering', category: 'Data & AI' },
  { name: 'mlops', display: 'MLOps', category: 'Data & AI' },
  { name: 'hugging face', display: 'Hugging Face', category: 'Data & AI' },
  { name: 'langchain', display: 'LangChain', category: 'Data & AI' },
  { name: 'openai', display: 'OpenAI', category: 'Data & AI' },
  { name: 'rag', display: 'RAG', category: 'Data & AI' },

  // Cloud & DevOps
  { name: 'aws', display: 'AWS', category: 'Cloud & DevOps' },
  { name: 'azure', display: 'Azure', category: 'Cloud & DevOps' },
  { name: 'gcp', display: 'GCP', category: 'Cloud & DevOps' },
  { name: 'docker', display: 'Docker', category: 'Cloud & DevOps' },
  { name: 'kubernetes', display: 'Kubernetes', category: 'Cloud & DevOps' },
  { name: 'terraform', display: 'Terraform', category: 'Cloud & DevOps' },
  { name: 'ansible', display: 'Ansible', category: 'Cloud & DevOps' },
  { name: 'ci/cd', display: 'CI/CD', category: 'Cloud & DevOps' },
  { name: 'linux', display: 'Linux', category: 'Cloud & DevOps' },
  { name: 'git', display: 'Git', category: 'Cloud & DevOps' },
  { name: 'agile', display: 'Agile', category: 'Cloud & DevOps' },
  { name: 'scrum', display: 'Scrum', category: 'Cloud & DevOps' },
  { name: 'jenkins', display: 'Jenkins', category: 'Cloud & DevOps' },
  { name: 'github actions', display: 'GitHub Actions', category: 'Cloud & DevOps' },
  { name: 'helm', display: 'Helm', category: 'Cloud & DevOps' },
  { name: 'prometheus', display: 'Prometheus', category: 'Cloud & DevOps' },
  { name: 'grafana', display: 'Grafana', category: 'Cloud & DevOps' },
  { name: 'cloud native', category: 'Cloud & DevOps' },
  { name: 'serverless', category: 'Cloud & DevOps' },
  { name: 'cloudformation', display: 'CloudFormation', category: 'Cloud & DevOps' },
  { name: 'pulumi', display: 'Pulumi', category: 'Cloud & DevOps' },
  { name: 'devops', display: 'DevOps', category: 'Cloud & DevOps' },

  // Databases
  { name: 'postgresql', display: 'PostgreSQL', category: 'Databases' },
  { name: 'mysql', display: 'MySQL', category: 'Databases' },
  { name: 'mongodb', display: 'MongoDB', category: 'Databases' },
  { name: 'redis', display: 'Redis', category: 'Databases' },
  { name: 'elasticsearch', display: 'Elasticsearch', category: 'Databases' },
  { name: 'snowflake', display: 'Snowflake', category: 'Databases' },
  { name: 'bigquery', display: 'BigQuery', category: 'Databases' },
  { name: 'sqlite', display: 'SQLite', category: 'Databases' },
  { name: 'cassandra', display: 'Cassandra', category: 'Databases' },
  { name: 'dynamodb', display: 'DynamoDB', category: 'Databases' },
  { name: 'oracle', display: 'Oracle', category: 'Databases' },
  { name: 'neo4j', display: 'Neo4j', category: 'Databases' },
  { name: 'mssql', display: 'MSSQL', category: 'Databases' },
  { name: 'mariadb', display: 'MariaDB', category: 'Databases' },
  { name: 'database design', category: 'Databases' },

  // Security
  { name: 'cybersecurity', category: 'Security' },
  { name: 'owasp', display: 'OWASP', category: 'Security' },
  { name: 'gdpr', display: 'GDPR', category: 'Security' },
  { name: 'iso 27001', display: 'ISO 27001', category: 'Security' },
  { name: 'encryption', category: 'Security' },
  { name: 'compliance', category: 'Security' },
  { name: 'penetration testing', category: 'Security' },
  { name: 'soc2', display: 'SOC 2', category: 'Security' },
  { name: 'zero trust', category: 'Security' },
  { name: 'siem', display: 'SIEM', category: 'Security' },
  { name: 'vulnerability assessment', category: 'Security' },
  { name: 'iam', display: 'IAM', category: 'Security' },
  { name: 'oauth', display: 'OAuth', category: 'Security' },
  { name: 'jwt', display: 'JWT', category: 'Security' },

  // Design
  { name: 'figma', display: 'Figma', category: 'Design' },
  { name: 'ux', display: 'UX', category: 'Design' },
  { name: 'ui', display: 'UI', category: 'Design' },
  { name: 'wireframing', category: 'Design' },
  { name: 'prototyping', category: 'Design' },
  { name: 'user research', category: 'Design' },
  { name: 'sketch', display: 'Sketch', category: 'Design' },
  { name: 'adobe xd', display: 'Adobe XD', category: 'Design' },
  { name: 'design systems', category: 'Design' },
  { name: 'accessibility', category: 'Design' },
  { name: 'information architecture', category: 'Design' },

  // Business
  { name: 'product management', category: 'Business' },
  { name: 'jira', display: 'Jira', category: 'Business' },
  { name: 'salesforce', display: 'Salesforce', category: 'Business' },
  { name: 'crm', display: 'CRM', category: 'Business' },
  { name: 'kpi', display: 'KPI', category: 'Business' },
  { name: 'forecasting', category: 'Business' },
  { name: 'stakeholder management', category: 'Business' },
  { name: 'roadmap', category: 'Business' },
  { name: 'okr', display: 'OKR', category: 'Business' },
  { name: 'business analysis', category: 'Business' },
  { name: 'project management', category: 'Business' },
  { name: 'confluence', display: 'Confluence', category: 'Business' },
  { name: 'notion', display: 'Notion', category: 'Business' },
  { name: 'lean', display: 'Lean', category: 'Business' },
  { name: 'six sigma', display: 'Six Sigma', category: 'Business' },
  { name: 'sprint planning', category: 'Business' },

  // Testing
  { name: 'unit testing', category: 'Testing' },
  { name: 'integration testing', category: 'Testing' },
  { name: 'jest', display: 'Jest', category: 'Testing' },
  { name: 'pytest', category: 'Testing' },
  { name: 'selenium', display: 'Selenium', category: 'Testing' },
  { name: 'cypress', display: 'Cypress', category: 'Testing' },
  { name: 'tdd', display: 'TDD', category: 'Testing' },
  { name: 'bdd', display: 'BDD', category: 'Testing' },
  { name: 'qa', display: 'QA', category: 'Testing' },
  { name: 'test automation', category: 'Testing' },
  { name: 'playwright', display: 'Playwright', category: 'Testing' },
];

/** Bump on any edit to a `display` value, or to the entry list itself. */
const SKILLS_VOCABULARY_VERSION = 'v-1';

module.exports = { SKILLS_DB, SKILLS_VOCABULARY_VERSION };
