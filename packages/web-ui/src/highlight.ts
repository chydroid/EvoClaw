export const LANG_META: Record<string, {
  keywords: string[];
  builtins: string[];
  types: string[];
  commentStyle: "slash" | "hash" | "dash" | "none";
  stringQuote: boolean;
}> = {
  javascript: {
    keywords: ["break","case","catch","class","const","continue","debugger","default","delete","do","else","export","extends","finally","for","function","if","import","in","instanceof","new","return","super","switch","this","throw","try","typeof","var","void","while","with","yield","let","static","of","as","async","await","from","get","set"],
    builtins: ["Array","Boolean","Date","Error","Function","JSON","Map","Math","Number","Object","Promise","RegExp","Set","String","Symbol","WeakMap","WeakSet","console","document","window","fetch","setTimeout","setInterval","clearTimeout","clearInterval","parseInt","parseFloat","isNaN","isFinite","eval","encodeURI","decodeURI","encodeURIComponent","decodeURIComponent","require","module","exports","process","Buffer","global","Intl","Reflect","Proxy","Atomics","SharedArrayBuffer","BigInt","BigInt64Array","BigUint64Array"],
    types: ["string","number","boolean","null","undefined","void","any","never","unknown"],
    commentStyle: "slash",
    stringQuote: true,
  },
  typescript: {
    keywords: ["break","case","catch","class","const","continue","debugger","default","delete","do","else","export","extends","finally","for","function","if","import","in","instanceof","new","return","super","switch","this","throw","try","typeof","var","void","while","with","yield","let","static","of","as","async","await","from","get","set","type","interface","enum","implements","namespace","declare","abstract","readonly","private","protected","public","keyof","infer","is","module","global","override","satisfies"],
    builtins: ["Array","Boolean","Date","Error","Function","JSON","Map","Math","Number","Object","Promise","RegExp","Set","String","Symbol","WeakMap","WeakSet","console","document","window","fetch","setTimeout","setInterval","clearTimeout","clearInterval","parseInt","parseFloat","isNaN","isFinite","eval","encodeURI","decodeURI","encodeURIComponent","decodeURIComponent","Partial","Required","Readonly","Pick","Omit","Record","Exclude","Extract","NonNullable","ReturnType","Parameters","Awaited","ConstructorParameters","InstanceType"],
    types: ["string","number","boolean","null","undefined","void","any","never","unknown","bigint","symbol"],
    commentStyle: "slash",
    stringQuote: true,
  },
  python: {
    keywords: ["False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield","match","case","type","self","cls"],
    builtins: ["abs","all","any","bin","bool","breakpoint","bytearray","bytes","callable","chr","classmethod","compile","complex","delattr","dict","dir","divmod","enumerate","eval","exec","filter","float","format","frozenset","getattr","globals","hasattr","hash","help","hex","id","input","int","isinstance","issubclass","iter","len","list","locals","map","max","memoryview","min","next","object","oct","open","ord","pow","print","property","range","repr","reversed","round","set","setattr","slice","sorted","staticmethod","str","sum","super","tuple","type","vars","zip","__import__","Exception","ValueError","TypeError","KeyError","IndexError","RuntimeError","StopIteration","FileNotFoundError"],
    types: ["int","float","str","list","dict","tuple","set","bool","bytes","bytearray","frozenset","complex","type","object","NoneType"],
    commentStyle: "hash",
    stringQuote: true,
  },
  java: {
    keywords: ["abstract","assert","boolean","break","byte","case","catch","char","class","const","continue","default","do","double","else","enum","exports","extends","final","finally","float","for","goto","if","implements","import","instanceof","int","interface","long","module","native","new","package","private","protected","public","requires","return","short","static","strictfp","super","switch","synchronized","this","throw","throws","transient","try","void","volatile","while","var","record","sealed","permits","yield"],
    builtins: ["System","String","Object","Integer","Long","Double","Float","Boolean","Byte","Short","Character","Math","ArrayList","HashMap","HashSet","LinkedList","TreeMap","TreeSet","Arrays","Collections","Stream","Optional","Comparator","Iterable","Iterator","List","Set","Map","Queue","Deque","Stack","Vector","StringBuilder","StringBuffer","Exception","RuntimeException","IOException","File","Scanner","PrintWriter"],
    types: ["int","long","double","float","boolean","byte","short","char","void","String","Object"],
    commentStyle: "slash",
    stringQuote: true,
  },
  cpp: {
    keywords: ["alignas","alignof","and","and_eq","asm","auto","bitand","bitor","bool","break","case","catch","char","char8_t","char16_t","char32_t","class","compl","concept","const","consteval","constexpr","constinit","const_cast","continue","co_await","co_return","co_yield","decltype","default","delete","do","double","dynamic_cast","else","enum","explicit","export","extern","false","float","for","friend","goto","if","inline","int","long","mutable","namespace","new","noexcept","not","not_eq","nullptr","operator","or","or_eq","private","protected","public","register","reinterpret_cast","requires","return","short","signed","sizeof","static","static_assert","static_cast","struct","switch","template","this","thread_local","throw","true","try","typedef","typeid","typename","union","unsigned","using","virtual","void","volatile","wchar_t","while","xor","xor_eq","override","final","import","module"],
    builtins: ["std","cout","cin","cerr","endl","vector","map","set","string","pair","tuple","array","queue","stack","priority_queue","deque","list","forward_list","unordered_map","unordered_set","multimap","multiset","shared_ptr","unique_ptr","weak_ptr","make_shared","make_unique","function","bind","thread","mutex","lock_guard","unique_lock","condition_variable","atomic","future","promise","async","initializer_list","move","forward","swap","size","begin","end","push_back","emplace_back","find","count","erase","clear","empty","reserve","capacity","getline"],
    types: ["int","long","short","char","float","double","bool","void","wchar_t","size_t","int8_t","int16_t","int32_t","int64_t","uint8_t","uint16_t","uint32_t","uint64_t","string","vector","map","set"],
    commentStyle: "slash",
    stringQuote: true,
  },
  csharp: {
    keywords: ["abstract","as","base","bool","break","byte","case","catch","char","checked","class","const","continue","decimal","default","delegate","do","double","else","enum","event","explicit","extern","false","finally","fixed","float","for","foreach","goto","if","implicit","in","int","interface","internal","is","lock","long","namespace","new","null","object","operator","out","override","params","private","protected","public","readonly","ref","return","sbyte","sealed","short","sizeof","stackalloc","static","string","struct","switch","this","throw","true","try","typeof","uint","ulong","unchecked","unsafe","ushort","using","var","virtual","void","volatile","while","record","init","required","global","file","dynamic","async","await","when","from","where","select","group","by","into","orderby","join","let","on","equals","ascending","descending"],
    builtins: ["Console","Math","String","Int32","Int64","Double","Decimal","Boolean","DateTime","TimeSpan","Guid","List","Dictionary","Queue","Stack","HashSet","LinkedList","SortedList","SortedDictionary","SortedSet","IEnumerable","IList","IDictionary","IQueryable","Enumerable","Array","Convert","Path","File","Directory","Stream","StreamReader","StreamWriter","FileStream","MemoryStream","HttpClient","HttpResponseMessage","Task","Thread","ThreadPool","Monitor","Semaphore","Mutex","CancellationToken","Tuple","ValueTuple","Nullable","Exception","ArgumentException","ArgumentNullException","InvalidOperationException","NotImplementedException","NullReferenceException","Lazy","Stopwatch","Regex","StringBuilder","StringWriter"],
    types: ["int","long","short","byte","float","double","decimal","bool","char","string","object","void","dynamic","var","nint","nuint"],
    commentStyle: "slash",
    stringQuote: true,
  },
  go: {
    keywords: ["break","case","chan","const","continue","default","defer","else","fallthrough","for","func","go","goto","if","import","interface","map","package","range","return","select","struct","switch","type","var"],
    builtins: ["append","cap","close","complex","copy","delete","imag","len","make","new","panic","print","println","real","recover","error","string","int","int8","int16","int32","int64","uint","uint8","uint16","uint32","uint64","float32","float64","bool","byte","rune","nil","true","false","iota"],
    types: ["int","int8","int16","int32","int64","uint","uint8","uint16","uint32","uint64","float32","float64","complex64","complex128","bool","byte","rune","string","error","any","comparable"],
    commentStyle: "slash",
    stringQuote: true,
  },
  rust: {
    keywords: ["as","async","await","break","const","continue","crate","dyn","else","enum","extern","false","fn","for","if","impl","in","let","loop","match","mod","move","mut","pub","ref","return","self","Self","static","struct","super","trait","true","type","union","unsafe","use","where","while","yield","abstract","become","box","do","final","macro","override","priv","try","typeof","unsized","virtual"],
    builtins: ["Some","None","Ok","Err","Vec","String","HashMap","HashSet","BTreeMap","BTreeSet","LinkedList","VecDeque","BinaryHeap","Option","Result","Box","Rc","Arc","Cell","RefCell","Mutex","RwLock","Barrier","Condvar","Once","thread","spawn","join","handle","panic","assert","assert_eq","assert_ne","debug_assert","format","print","println","eprint","eprintln","write","writeln","include","include_str","include_bytes","env","args","std","io","fs","path","process","env","collections","iter","clone","copy","drop","default","from","into","try_from","try_into","to_string","to_owned","as_ref","as_mut","borrow","borrow_mut","deref","deref_mut"],
    types: ["i8","i16","i32","i64","i128","isize","u8","u16","u32","u64","u128","usize","f32","f64","bool","char","str","String","Vec","&str","Box","Rc","Arc"],
    commentStyle: "slash",
    stringQuote: true,
  },
  ruby: {
    keywords: ["BEGIN","END","alias","and","begin","break","case","class","def","defined","do","else","elsif","end","ensure","false","for","if","in","module","next","nil","not","or","redo","rescue","retry","return","self","super","then","true","undef","unless","until","when","while","yield","__FILE__","__LINE__","__ENCODING__"],
    builtins: ["puts","print","gets","chomp","split","join","map","select","reject","reduce","each","times","upto","downto","include","length","size","empty","nil","upcase","downcase","capitalize","strip","gsub","sub","match","scan","to_s","to_i","to_f","to_a","to_h","new","initialize","attr_accessor","attr_reader","attr_writer","require","include","extend","prepend","Array","Hash","String","Integer","Float","Symbol","Proc","Lambda","Range","Regexp","Time","Date","File","Dir","IO","Enumerable","Comparable"],
    types: [],
    commentStyle: "hash",
    stringQuote: true,
  },
  php: {
    keywords: ["abstract","and","array","as","break","callable","case","catch","class","clone","const","continue","declare","default","die","do","echo","else","elseif","empty","enddeclare","endfor","endforeach","endif","endswitch","endwhile","eval","exit","extends","final","finally","fn","for","foreach","function","global","goto","if","implements","include","include_once","instanceof","insteadof","interface","isset","list","match","namespace","new","or","print","private","protected","public","readonly","require","require_once","return","static","switch","throw","trait","try","unset","use","var","while","xor","yield","from"],
    builtins: ["array","count","in_array","array_push","array_pop","array_shift","array_unshift","array_merge","array_keys","array_values","sort","rsort","strlen","strpos","str_replace","substr","trim","explode","implode","json_encode","json_decode","file_get_contents","file_put_contents","fopen","fclose","fgets","fwrite","preg_match","preg_replace","date","time","strtotime","isset","empty","defined","define","class_exists","method_exists","property_exists","is_array","is_string","is_int","is_float","is_bool","is_null","is_object","echo","print","var_dump","print_r","die","exit","header","setcookie","session_start","mysqli_connect","PDO"],
    types: [],
    commentStyle: "slash",
    stringQuote: true,
  },
  swift: {
    keywords: ["associatedtype","async","await","break","case","catch","class","continue","default","defer","deinit","do","else","enum","extension","fallthrough","false","fileprivate","for","func","guard","if","import","in","init","inout","internal","is","let","nil","open","operator","precedencegroup","private","protocol","public","repeat","rethrows","return","self","Self","static","struct","subscript","super","switch","throw","throws","true","try","typealias","var","where","while","didSet","get","set","willSet","nonisolated","isolated","actor","distributed","nonmutating","async","await","some","any","macro"],
    builtins: ["print","dump","debugPrint","assert","precondition","fatalError","assertionFailure","readLine","type","Int","Float","Double","Bool","String","Character","Array","Dictionary","Set","Optional","Result","Error","Data","Date","URL","UUID","Timer","NotificationCenter","UserDefaults","FileManager","Bundle","Codable","Encodable","Decodable","JSONEncoder","JSONDecoder","PropertyListEncoder","PropertyListDecoder","map","filter","reduce","flatMap","compactMap","forEach","sort","sorted","first","last","isEmpty","count","append","insert","remove","contains","joined","split","components","hasPrefix","hasSuffix","lowercased","uppercased","trimmingCharacters"],
    types: ["Int","Int8","Int16","Int32","Int64","UInt","UInt8","UInt16","UInt32","UInt64","Float","Double","Float80","Bool","String","Character","Void","Never","Any","AnyObject","Optional","Array","Dictionary","Set","ClosedRange","Range","Data","Date","URL"],
    commentStyle: "slash",
    stringQuote: true,
  },
  kotlin: {
    keywords: ["abstract","annotation","as","break","by","catch","class","companion","const","constructor","continue","crossinline","data","delegate","do","dynamic","else","enum","expect","external","false","field","file","final","finally","for","fun","get","if","import","in","infix","init","inline","inner","interface","internal","is","it","lateinit","noinline","null","object","open","operator","out","override","package","param","private","property","protected","public","receiver","reified","return","sealed","set","setparam","super","suspend","tailrec","this","throw","true","try","typealias","val","var","vararg","when","where","while","actual"],
    builtins: ["println","print","readLine","readln","listOf","mutableListOf","setOf","mutableSetOf","mapOf","mutableMapOf","arrayOf","intArrayOf","doubleArrayOf","emptyList","emptySet","emptyMap","Pair","Triple","let","run","with","apply","also","takeIf","takeUnless","forEach","map","filter","flatMap","groupBy","associate","sortedBy","first","last","single","find","any","all","none","count","sum","max","min","average","joinToString","toList","toSet","toMap","require","requireNotNull","check","checkNotNull","error","TODO","runCatching","getOrElse","getOrNull","orEmpty"],
    types: ["Int","Long","Short","Byte","Float","Double","Char","Boolean","String","Unit","Nothing","Any","Array","List","MutableList","Set","MutableSet","Map","MutableMap","Sequence","Pair","Triple"],
    commentStyle: "slash",
    stringQuote: true,
  },
  dart: {
    keywords: ["abstract","as","assert","async","await","break","case","catch","class","const","continue","covariant","default","deferred","do","dynamic","else","enum","export","extends","extension","external","factory","false","final","finally","for","Function","get","hide","if","implements","import","in","interface","is","late","library","mixin","new","null","on","operator","part","required","rethrow","return","sealed","set","show","static","super","switch","sync","this","throw","true","try","typedef","var","void","when","while","with","yield"],
    builtins: ["print","Object","num","int","double","String","bool","List","Set","Map","Iterable","Future","Stream","DateTime","Duration","Uri","RegExp","Match","Error","Exception","StackTrace","Stopwatch","Timer","Isolate","Random","Math","json","convert","utf8","base64","toString","parse","tryParse","from","of","where","map","forEach","fold","reduce","every","any","contains","join","split","replaceAll","trim","toLowerCase","toUpperCase","substring","isEmpty","isNotEmpty","length","add","addAll","remove","removeAt","clear","keys","values","entries"],
    types: ["int","double","num","String","bool","List","Set","Map","void","dynamic","Object","Never","Null","Future","Stream","Iterable","Symbol","Runes","BigInt","DateTime","Duration","RegExp","Type","Uri"],
    commentStyle: "slash",
    stringQuote: true,
  },
  scala: {
    keywords: ["abstract","case","catch","class","def","do","else","extends","false","final","finally","for","forSome","if","implicit","import","lazy","match","new","null","object","override","package","private","protected","return","sealed","super","this","throw","trait","true","try","type","val","var","while","with","yield","given","using","extension","inline","opaque","open","export","then","end","enum","transparent"],
    builtins: ["println","print","require","assert","assume","Predef","Any","AnyVal","AnyRef","Nothing","Null","Unit","Boolean","Byte","Short","Int","Long","Float","Double","Char","String","Symbol","Function","Tuple","Option","Some","None","Either","Left","Right","Try","Success","Failure","Future","Promise","List","Seq","Set","Map","Vector","Array","ArrayBuffer","Range","Stream","Iterator","Iterable","Traversable","Map","flatMap","filter","fold","reduce","collect","foreach","exists","forall","find","groupBy","sortBy","sorted","head","tail","init","last","take","drop","splitAt","mkString","toString","toInt","toDouble","length","size","isEmpty"],
    types: ["Boolean","Byte","Short","Int","Long","Float","Double","Char","String","Unit","Null","Nothing","Any","AnyVal","AnyRef","Option"],
    commentStyle: "slash",
    stringQuote: true,
  },
  r: {
    keywords: ["break","else","for","function","if","in","next","repeat","return","while","TRUE","FALSE","NULL","Inf","NaN","NA","NA_integer_","NA_real_","NA_complex_","NA_character_"],
    builtins: ["c","list","matrix","array","data.frame","factor","table","plot","hist","boxplot","summary","head","tail","str","class","typeof","length","dim","nrow","ncol","names","rownames","colnames","mean","median","sd","var","sum","min","max","range","abs","sqrt","log","exp","sin","cos","tan","seq","rep","sort","order","rank","rev","unique","duplicated","match","paste","print","cat","message","warning","stop","library","require","install.packages","source","read.csv","write.csv","read.table","write.table","readRDS","saveRDS","load","save","ls","rm","getwd","setwd","list.files","file.exists","dir.create","lm","glm","anova","t.test","cor","cov","prcomp","kmeans","hclust","as.numeric","as.character","as.factor","as.logical","as.integer","is.na","is.null","is.numeric","is.character","is.factor","is.logical","subset","merge","aggregate","transform","with","within","attach","detach","grep","gsub","sub","strsplit","nchar","tolower","toupper"],
    types: ["numeric","integer","character","logical","factor","list","matrix","data.frame","vector","complex","raw"],
    commentStyle: "hash",
    stringQuote: true,
  },
  lua: {
    keywords: ["and","break","do","else","elseif","end","false","for","function","goto","if","in","local","nil","not","or","repeat","return","then","true","until","while"],
    builtins: ["print","type","tonumber","tostring","ipairs","pairs","next","rawget","rawset","rawlen","rawequal","setmetatable","getmetatable","select","pcall","xpcall","error","assert","load","loadfile","dofile","require","module","package","string","math","table","io","os","debug","coroutine","unpack","table.insert","table.remove","table.sort","table.concat","string.sub","string.len","string.find","string.match","string.gmatch","string.gsub","string.format","string.upper","string.lower","string.reverse","string.rep","string.byte","string.char","math.abs","math.floor","math.ceil","math.max","math.min","math.sqrt","math.random","math.pi","math.sin","math.cos","os.date","os.time","os.clock","os.execute","os.exit","io.open","io.close","io.read","io.write","io.lines"],
    types: [],
    commentStyle: "dash",
    stringQuote: true,
  },
  haskell: {
    keywords: ["as","case","class","data","default","deriving","do","else","hiding","if","import","in","infix","infixl","infixr","instance","let","module","newtype","of","qualified","then","type","where"],
    builtins: ["map","filter","foldl","foldr","zip","zipWith","concat","concatMap","head","tail","init","last","take","drop","takeWhile","dropWhile","span","break","null","length","elem","notElem","and","or","any","all","reverse","repeat","cycle","iterate","replicate","splitAt","lines","words","unlines","unwords","show","read","putStr","putStrLn","print","getLine","getContents","interact","readFile","writeFile","appendFile","Maybe","Just","Nothing","Either","Left","Right","IO","Int","Integer","Float","Double","Char","Bool","String","Eq","Ord","Show","Read","Enum","Bounded","Num","Real","Integral","Fractional","Floating","RealFrac","RealFloat","Monad","Functor","Applicative","Foldable","Traversable","Sequence","Map","Set","Vector","ByteString","Text","fmap","return","pure","bind","join"],
    types: ["Int","Integer","Float","Double","Char","Bool","String","IO","Maybe","Either","[]","()"],
    commentStyle: "dash",
    stringQuote: true,
  },
  sql: {
    keywords: ["ADD","ALL","ALTER","AND","ANY","AS","ASC","BACKUP","BETWEEN","BY","CASE","CHECK","COLUMN","CONSTRAINT","CREATE","DATABASE","DEFAULT","DELETE","DESC","DISTINCT","DROP","EXEC","EXISTS","FOREIGN","FROM","FULL","GROUP","HAVING","IN","INDEX","INNER","INSERT","INTO","IS","JOIN","KEY","LEFT","LIKE","LIMIT","NOT","NULL","OFFSET","ON","OR","ORDER","OUTER","PRIMARY","PROCEDURE","RIGHT","SELECT","SET","TABLE","TOP","TRUNCATE","UNION","UPDATE","VALUES","VIEW","WHERE","COUNT","SUM","AVG","MAX","MIN","IF"],
    builtins: ["CAST","COALESCE","CONVERT","CURRENT_DATE","CURRENT_TIME","CURRENT_TIMESTAMP","EXTRACT","NULLIF","ABS","CEIL","FLOOR","ROUND","TRUNCATE","CHAR_LENGTH","CONCAT","LENGTH","LOWER","LTRIM","REPLACE","RTRIM","SUBSTRING","TRIM","UPPER","DATE_ADD","DATE_SUB","DATEDIFF","NOW"],
    types: ["INT","INTEGER","BIGINT","SMALLINT","TINYINT","DECIMAL","NUMERIC","FLOAT","REAL","CHAR","VARCHAR","TEXT","NCHAR","NVARCHAR","NTEXT","DATE","TIME","DATETIME","TIMESTAMP","BIT","BINARY","VARBINARY","IMAGE","BOOLEAN","BOOLEAN","MONEY","XML","JSON","UUID","ARRAY"],
    commentStyle: "dash",
    stringQuote: true,
  },
  bash: {
    keywords: ["if","then","else","elif","fi","for","while","do","done","case","esac","function","return","exit","in","select","until","break","continue","declare","typeset","local","export","readonly","unset","shift","source"],
    builtins: ["echo","printf","read","cd","pwd","ls","cat","cp","mv","rm","mkdir","rmdir","touch","chmod","chown","ln","find","grep","sed","awk","cut","sort","uniq","wc","head","tail","diff","tar","gzip","gunzip","zip","unzip","ssh","scp","curl","wget","ps","kill","top","df","du","free","uname","whoami","id","env","export","set","unset","alias","unalias","type","which","man","expr","test","true","false","basename","dirname","sleep","wait","trap","exec","eval","history","pushd","popd","dirs"],
    types: [],
    commentStyle: "hash",
    stringQuote: true,
  },
  html: {
    keywords: [],
    builtins: [],
    types: [],
    commentStyle: "none",
    stringQuote: false,
  },
  css: {
    keywords: [],
    builtins: [],
    types: [],
    commentStyle: "slash",
    stringQuote: false,
  },
  xml: {
    keywords: [],
    builtins: [],
    types: [],
    commentStyle: "none",
    stringQuote: false,
  },
  yaml: {
    keywords: ["true","false","null","yes","no","on","off","yaml","YAML"],
    builtins: [],
    types: [],
    commentStyle: "hash",
    stringQuote: true,
  },
  json: {
    keywords: ["true","false","null"],
    builtins: [],
    types: [],
    commentStyle: "none",
    stringQuote: true,
  },
  markdown: {
    keywords: [],
    builtins: [],
    types: [],
    commentStyle: "none",
    stringQuote: false,
  },
  perl: {
    keywords: ["if","else","elsif","unless","while","until","for","foreach","do","last","next","redo","return","sub","my","our","local","use","require","package","bless","new","defined","undef","eq","ne","lt","gt","le","ge","cmp","not","and","or","xor"],
    builtins: ["print","say","printf","sprintf","open","close","read","write","seek","tell","chomp","chop","split","join","length","substr","index","rindex","push","pop","shift","unshift","splice","sort","reverse","grep","map","keys","values","each","defined","delete","exists","ref","bless","eval","die","warn","carp","croak","confess","caller","wantarray","time","localtime","gmtime","sleep","system","exec","$ENV","STDIN","STDOUT","STDERR","@ARGV","$0","$1","$2","$3"],
    types: [],
    commentStyle: "hash",
    stringQuote: true,
  },
};

export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function highlightCode(escaped: string, lang: string): string {
  let result = escaped;
  if (!lang) return result;

  const langLower = lang.toLowerCase();
  const meta = LANG_META[langLower];
  if (!meta) return result;

  const { keywords, builtins, types, commentStyle, stringQuote } = meta;
  const kwSet = new Set(keywords);
  const biSet = new Set(builtins);
  const tySet = new Set(types);

  const isMarkup = langLower === "html" || langLower === "css" || langLower === "xml" || langLower === "svg";

  if (!isMarkup && stringQuote) {
    result = result.replace(
      /(["'`])(?:(?!\1|\\).|\\.)*\1/g,
      (match) => `<span class="code-string">${match}</span>`
    );
  }

  if (commentStyle === "slash") {
    result = result.replace(
      /\/\*[\s\S]*?\*\//g,
      (match) => `<span class="code-comment">${match}</span>`
    );
    result = result.replace(
      /\/\/.*$/gm,
      (match) => `<span class="code-comment">${match}</span>`
    );
  } else if (commentStyle === "hash") {
    result = result.replace(
      /#.*$/gm,
      (match) => `<span class="code-comment">${match}</span>`
    );
  } else if (commentStyle === "dash") {
    result = result.replace(
      /--.*$/gm,
      (match) => `<span class="code-comment">${match}</span>`
    );
  }

  if (isMarkup) {
    if (langLower === "css") {
      result = result.replace(
        /\/\*[\s\S]*?\*\//g,
        (match) => `<span class="code-comment">${match}</span>`
      );
    }
    if (langLower === "html" || langLower === "xml" || langLower === "svg") {
      result = result.replace(
        /&lt;!--[\s\S]*?--&gt;/g,
        (match) => `<span class="code-comment">${match}</span>`
      );
      result = result.replace(
        /(class|id|style|src|href|alt|type|name|rel|lang|charset|content|viewport|width|height|onclick|onload|onerror|onsubmit|onchange|oninput)\s*=/gi,
        (match) => {
          const key = match.slice(0, -1).trim();
          return `<span class="code-keyword">${key}</span>=`;
        }
      );
      result = result.replace(
        /(&lt;\/?)(\w+)/g,
        (match, tagStart, tagName) => `${tagStart}<span class="code-keyword">${tagName}</span>`
      );
      result = result.replace(
        /=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
        (match) => {
          const eq = match.charAt(0);
          const val = match.slice(1);
          return `${eq}<span class="code-string">${val}</span>`;
        }
      );
    }
    if (langLower === "css") {
      result = result.replace(
        /([\w-]+)(\s*:\s*)([^;{]+?)([;}])/g,
        (match, prop, colon, value, end) =>
          `<span class="code-keyword">${prop}</span>${colon}<span class="code-number">${value.trim()}</span>${end}`
      );
      result = result.replace(
        /(?:\b|^)(\.|#)([\w-]+)/g,
        (match, prefix, name) => `${prefix}<span class="code-function">${name}</span>`
      );
    }
  } else {
    const allKeywords = new Set([...kwSet, ...biSet, ...tySet]);
    const keywordPattern = new RegExp(
      `\\b(${[...allKeywords].join("|")})\\b`,
      "g"
    );
    result = result.replace(
      keywordPattern,
      (match) => {
        if (kwSet.has(match)) return `<span class="code-keyword">${match}</span>`;
        if (biSet.has(match)) return `<span class="code-builtin">${match}</span>`;
        if (tySet.has(match)) return `<span class="code-type">${match}</span>`;
        return match;
      }
    );
  }

  result = result.replace(
    /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g,
    (match) => `<span class="code-number">${match}</span>`
  );

  result = result.replace(
    /\b([A-Z][a-zA-Z0-9_]*)\b/g,
    (match) => `<span class="code-type">${match}</span>`
  );

  return result;
}