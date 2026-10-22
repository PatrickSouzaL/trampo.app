// TechDictionary `td1` (ADR-016 D6): os termos do `td-s4` do S-4, escritos SEM consultar o gabarito do golden
// dataset (o recall não é inflado por vazamento). Aliases já dobrados (minúsculas, sem acento). Formato de cada
// linha: "Canônico|alias|alias". O canônico é a única grafia que sai do pré-filtro: um conjunto fechado.

export const TECH_DICTIONARY_VERSION = "td1";

const UNAMBIGUOUS: readonly string[] = [
  "JavaScript|javascript|js|ecmascript|es6", "TypeScript|typescript|ts", "Node.js|node.js|nodejs|node js|node",
  "React|react|react.js|reactjs", "React Native|react native", "Angular|angular|angularjs|angular.js",
  "Vue.js|vue|vue.js|vuejs", "Nuxt|nuxt|nuxt.js|nuxtjs", "Next.js|next.js|nextjs", "Svelte|svelte",
  "NestJS|nestjs|nest.js", "Express|express.js|expressjs", "jQuery|jquery", "HTML|html|html5", "CSS|css|css3",
  "Sass|sass|scss", "Tailwind CSS|tailwind|tailwindcss|tailwind css", "Bootstrap|bootstrap", "Redux|redux",
  "Java|java", "Spring Boot|spring boot|springboot", "Spring|spring framework", "Kotlin|kotlin", "Scala|scala",
  "Groovy|groovy", ".NET|.net|dotnet|.net core|net core", "ASP.NET|asp.net|asp.net core|aspnet", "C#|c#|csharp",
  "C++|c++|cpp", "Python|python", "Django|django", "Django REST Framework|django rest framework|drf", "Azure SQL|azure sql|azure sql database|azure sql managed instance|sql managed instance", "Flask|flask", "FastAPI|fastapi", "pandas|pandas",
  "NumPy|numpy", "PySpark|pyspark", "PyTorch|pytorch", "TensorFlow|tensorflow", "scikit-learn|scikit-learn|sklearn",
  "Go|golang", "PHP|php", "Laravel|laravel", "Symfony|symfony", "WordPress|wordpress", "Ruby|ruby",
  "Ruby on Rails|ruby on rails|rails", "Perl|perl", "Delphi|delphi", "COBOL|cobol", "VB.NET|vb.net",
  "VBA|vba", "Visual Basic|visual basic", "Flutter|flutter", "SwiftUI|swiftui", "Objective-C|objective-c",
  "Ionic|ionic", "Xamarin|xamarin", "Unity|unity3d", "Shell Script|shell script|bash", "PowerShell|powershell",
  "SQL|sql", "PL/SQL|pl/sql|plsql", "T-SQL|t-sql|tsql", "PostgreSQL|postgresql|postgres", "MySQL|mysql",
  "MariaDB|mariadb", "SQL Server|sql server|sqlserver|mssql", "Oracle|oracle", "SQLite|sqlite",
  "MongoDB|mongodb|mongo", "Redis|redis", "Cassandra|cassandra", "DynamoDB|dynamodb|amazon dynamodb", "Elasticsearch|elasticsearch",
  "OpenSearch|opensearch", "Firebase|firebase", "Supabase|supabase", "Neo4j|neo4j", "Snowflake|snowflake",
  "BigQuery|bigquery|big query", "Databricks|databricks", "Apache Spark|apache spark", "Hadoop|hadoop",
  "Apache Airflow|airflow|apache airflow", "Kafka|kafka|apache kafka", "RabbitMQ|rabbitmq", "dbt|dbt",
  "AWS|aws|amazon web services", "Amazon S3|s3|amazon s3", "AWS Lambda|lambda|aws lambda", "Amazon EC2|ec2|amazon ec2",
  "Amazon ECS|ecs|amazon ecs", "Amazon EKS|eks|amazon eks", "Amazon RDS|rds|amazon rds", "Amazon SQS|sqs|amazon sqs",
  "Amazon SNS|sns|amazon sns", "AWS Glue|aws glue|glue", "Amazon Redshift|redshift", "CloudFormation|cloudformation|aws cloudformation",
  "Azure|azure|microsoft azure", "Azure DevOps|azure devops", "GCP|gcp|google cloud|google cloud platform",
  "Docker|docker", "Kubernetes|kubernetes|k8s", "OpenShift|openshift", "Helm|helm", "Terraform|terraform",
  "Ansible|ansible", "Jenkins|jenkins", "GitHub Actions|github actions", "GitLab CI|gitlab ci|gitlab-ci|gitlab ci/cd",
  "ArgoCD|argocd|argo cd", "Git|git", "GitHub|github", "GitLab|gitlab", "Bitbucket|bitbucket", "Jira|jira",
  "Confluence|confluence", "Linux|linux", "Windows Server|windows server", "Ubuntu|ubuntu", "Red Hat|red hat|rhel",
  "Nginx|nginx", "Apache HTTP Server|apache http", "Prometheus|prometheus", "Grafana|grafana", "Zabbix|zabbix",
  "Datadog|datadog", "New Relic|new relic", "Splunk|splunk", "ELK|elk", "Kibana|kibana", "Logstash|logstash",
  "Dynatrace|dynatrace", "Sentry|sentry", "SonarQube|sonarqube|sonar", "Selenium|selenium", "Cypress|cypress",
  "Playwright|playwright", "Jest|jest", "JUnit|junit", "Postman|postman", "Appium|appium", "Cucumber|cucumber",
  "REST|rest|restful|api rest|apis rest", "GraphQL|graphql", "SOAP|soap", "gRPC|grpc", "OAuth|oauth|oauth2",
  "Power BI|power bi|powerbi", "Tableau|tableau", "Looker|looker", "Qlik|qlik|qlikview|qlik sense", "Excel|excel",
  "Power Automate|power automate", "Power Apps|power apps|powerapps", "SharePoint|sharepoint|sharepoint online",
  "Microsoft Office|pacote office|microsoft office|ms office|office 365|microsoft 365", "Google Sheets|google sheets",
  "SAP|sap", "SAP S/4HANA|s/4hana|s4hana", "TOTVS|totvs|protheus|totvs rm", "Salesforce|salesforce", "NetSuite|netsuite",
  "Sankhya|sankhya", "Oracle EBS|oracle ebs", "AutoCAD|autocad", "Revit|revit", "SolidWorks|solidworks",
  "SketchUp|sketchup", "MS Project|ms project|microsoft project", "Primavera|primavera p6", "Figma|figma",
  "Adobe Photoshop|photoshop", "Adobe Illustrator|illustrator", "Adobe XD|adobe xd", "Canva|canva",
  "Google Analytics|google analytics", "Google Ads|google ads", "Meta Ads|meta ads|facebook ads", "HubSpot|hubspot",
  "RD Station|rd station", "LangChain|langchain", "LangGraph|langgraph", "Hugging Face|hugging face|huggingface|hugging face transformers",
  "OpenAI|openai", "Burp Suite|burp suite|burp", "Semgrep|semgrep", "Wireshark|wireshark", "Fortinet|fortinet|fortigate",
  "Active Directory|active directory", "VMware|vmware", "Hyper-V|hyper-v", "Veeam|veeam", "Citrix|citrix",
  "Keycloak|keycloak", "Vercel|vercel", "Heroku|heroku", "Matlab|matlab",
  "Copilot|copilot|github copilot", "Storybook|storybook", "Webpack|webpack", "Vite|vite", "Tomcat|tomcat",
  "Hibernate|hibernate", "Maven|maven", "Gradle|gradle", "Quarkus|quarkus", "Micronaut|micronaut",
];

/** Termo ambíguo (ADR-001 §5.3): só é explícito com qualificador; senão, a menção é fraca. */
export interface AmbiguousSpec {
  readonly canonical: string;
  readonly alias: string;
  /** Frases que contêm o alias e o desambiguam: a ocorrência precisa cair dentro de uma delas. */
  readonly phrases: readonly string[];
  /** Palavras que, na mesma linha, desambiguam. */
  readonly lineCues: readonly string[];
}

const AMBIGUOUS: readonly AmbiguousSpec[] = [
  {
    canonical: "Go",
    alias: "go",
    phrases: ["linguagem go", "go lang", "go language", "experiencia com go", "experiencia em go", "programacao em go",
      "desenvolvimento em go", "go (golang)", "em go e", "go ou", "ou go"],
    lineCues: ["golang"],
  },
  { canonical: "R", alias: "r", phrases: ["linguagem r", "r language", "programacao em r", "python ou r", "python e r", "r ou python", "r e python"], lineCues: ["rstudio", "tidyverse"] },
  { canonical: "C", alias: "c", phrases: ["linguagem c", "c language", "programacao em c", "c/c++", "c e c++", "c ou c++"], lineCues: ["embarcad", "firmware"] },
  { canonical: "Swift", alias: "swift", phrases: ["linguagem swift"], lineCues: ["ios", "xcode", "swiftui", "objective-c"] },
  { canonical: "Dart", alias: "dart", phrases: ["linguagem dart"], lineCues: ["flutter"] },
  { canonical: "Rust", alias: "rust", phrases: ["linguagem rust", "rust lang"], lineCues: ["cargo", "linguagens"] },
  { canonical: "Elixir", alias: "elixir", phrases: ["linguagem elixir"], lineCues: ["phoenix", "erlang"] },
  { canonical: "Lua", alias: "lua", phrases: ["linguagem lua"], lineCues: ["nginx", "openresty", "roblox"] },
  { canonical: "Spark", alias: "spark", phrases: [], lineCues: ["databricks", "hadoop", "scala", "big data", "pyspark"] },
  { canonical: "Senior", alias: "senior", phrases: ["erp senior", "senior sistemas", "sistema senior"], lineCues: ["erp", "erps", "totvs"] },
  { canonical: "Microsoft Word", alias: "word", phrases: ["microsoft word", "ms word"], lineCues: ["excel", "powerpoint", "pacote office"] },
  { canonical: "Microsoft Access", alias: "access", phrases: ["microsoft access", "ms access"], lineCues: ["vba"] },
  { canonical: "Express", alias: "express", phrases: [], lineCues: ["node", "nodejs", "node.js"] },
];

export interface DictionaryAlias {
  readonly canonical: string;
  readonly alias: string;
  readonly ambiguous: AmbiguousSpec | null;
}

/** "Canônico|alias|alias" → aliases. Linha sem alias falha fechado. */
export function parseDictionaryRow(row: string): DictionaryAlias[] {
  const [canonical = "", ...aliases] = row.split("|");
  if (canonical === "" || aliases.length === 0 || aliases.includes("")) throw new RangeError("Linha do TechDictionary inválida.");
  return aliases.map((alias) => ({ canonical, alias, ambiguous: null }));
}

/** Aliases mais longos primeiro: "spring boot" vence "spring", "sql server" vence "sql". */
export const DICTIONARY_ALIASES: readonly DictionaryAlias[] = [
  ...UNAMBIGUOUS.flatMap(parseDictionaryRow),
  ...AMBIGUOUS.map((spec) => ({ canonical: spec.canonical, alias: spec.alias, ambiguous: spec })),
].sort((a, b) => b.alias.length - a.alias.length);

/** Os canônicos: o conjunto fechado de termos que o pré-filtro pode emitir. */
export const DICTIONARY_TERMS: ReadonlySet<string> = new Set(DICTIONARY_ALIASES.map((entry) => entry.canonical));
