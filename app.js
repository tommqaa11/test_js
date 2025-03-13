const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const { NacosNamingClient } = require('nacos');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const sharp = require('sharp');

// 加载环境变量
dotenv.config();

// 日志设置
const logger = {
  info: (message) => console.log(`[INFO] ${new Date().toISOString()} - ${message}`),
  error: (message) => console.error(`[ERROR] ${new Date().toISOString()} - ${message}`),
  debug: (message) => console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`),
  warning: (message) => console.warn(`[WARNING] ${new Date().toISOString()} - ${message}`)
};

// 服务器配置
const SERVER_IP = process.env.SERVER_IP || getLocalIP();
const SERVER_PORT = process.env.SERVER_PORT || 5001;

// Nacos配置
const NACOS_SERVER_ADDR = process.env.NACOS_SERVER_ADDR || "113.44.56.231:8848";
const NACOS_NAMESPACE = process.env.NACOS_NAMESPACE || "public";
const SERVICE_NAME = "STYLE_AI@@recommended-agent";

// 获取本地IP地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// 创建Nacos客户端
const nacosClient = new NacosNamingClient({
  serverList: NACOS_SERVER_ADDR,
  namespace: NACOS_NAMESPACE,
  username: 'admin',
  password: 'admin'
});

// 注册服务到Nacos
async function registerService() {
  try {
    // 服务实例信息
    const instance = {
      ip: SERVER_IP,
      port: SERVER_PORT,
      metadata: {
        'preserved.register.source': 'NODE_SDK',
        'service.type': 'recommended_agent',
        'version': '1.0.0',
        'group': 'STYLE_AI'
      },
      healthy: true,
      weight: 1.0,
      enabled: true,
      ephemeral: true // 临时实例
    };

    // 注册服务实例
    await nacosClient.registerInstance(SERVICE_NAME, {
      ip: SERVER_IP,
      port: SERVER_PORT,
      metadata: instance.metadata,
      groupName: 'STYLE_AI'
    });

    logger.info(`成功将服务注册到Nacos: ${SERVICE_NAME}`);
  } catch (e) {
    logger.error(`注册服务到Nacos时出错: ${e.message}`);
  }
}

// 从Nacos注销服务
async function deregisterService() {
  try {
    await nacosClient.deregisterInstance(SERVICE_NAME, {
      ip: SERVER_IP,
      port: SERVER_PORT,
      groupName: 'STYLE_AI'
    });

    logger.info(`成功从Nacos注销服务: ${SERVICE_NAME}`);
  } catch (e) {
    logger.error(`从Nacos注销服务时出错: ${e.message}`);
  }
}

// 发送心跳到Nacos
async function sendHeartbeat() {
  try {
    await nacosClient.sendInstanceBeat(SERVICE_NAME, {
      ip: SERVER_IP,
      port: SERVER_PORT,
      groupName: 'STYLE_AI',
      metadata: {
        'preserved.register.source': 'NODE_SDK',
        'service.type': 'file-upload',
        'version': '1.0.0',
        'group': 'STYLE_AI'
      }
    });
    logger.debug("成功发送心跳到Nacos");
  } catch (e) {
    logger.error(`发送心跳到Nacos时出错: ${e.message}`);
  }
}

// 初始化Express应用
const app = express();
app.use(express.json({ limit: '50mb' }));

// TavilyClient类，用于处理与Tavily搜索API的交互
class TavilyClient {
  constructor(apiKey = null, maxRetries = 3) {
    this.apiKey = apiKey || "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";
    if (!this.apiKey) {
      throw new Error("Tavily API 密钥未设置");
    }

    this.baseUrl = "https://api.tavily.com";
    this.headers = {
      "Content-Type": "application/json",
      "api-key": this.apiKey
    };
    this.maxRetries = maxRetries;
  }

  async search(query) {
    try {
      const endpoint = `${this.baseUrl}/search`;
      const payload = {
        query: query,
        search_depth: "basic",
        max_results: 2,
        api_key: this.apiKey,
        include_raw_content: true,
        include_images: true,
        include_answer: true
      };

      // 带重试机制的请求
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const response = await axios.post(endpoint, payload, {
            headers: this.headers,
            timeout: 60000 // 60秒超时
          });

          if (response.status === 200) {
            const results = response.data.results || [];
            return results.map(result => 
              `标题: ${result.title}\n` +
              `原始内容: ${result.raw_content || ''}\n` +
              `链接: ${result.url}\n`
            ).join('\n');
          } else {
            throw new Error(`Tavily API 错误: ${response.status}`);
          }
        } catch (error) {
          if (attempt === this.maxRetries) {
            throw error;
          }
          // 指数退避策略
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    } catch (e) {
      console.error(`搜索错误: ${e.message}`);
      return "";
    }
  }
}

// 初始化Tavily搜索
const tavilyClient = new TavilyClient();

// 阿里云通义千问大语言模型类
class QwenLLM {
  constructor(apiKey = null, model = "qwen-turbo") {
    this.apiKey = apiKey || "sk-8b17bc160ce4413388fa1a0362934e31";
    this.model = model;
    this.baseUrl = "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
  }

  async invoke(input, config = {}) {
    try {
      let prompt;
      if (typeof input === 'object') {
        prompt = input.prompt || "";
      } else {
        prompt = String(input);
      }

      // 合并配置
      const finalConfig = {
        ...config
      };

      // 移除不必要的字段
      delete finalConfig.stop;
      delete finalConfig.callbacks;
      delete finalConfig.callback_manager;

      // 调用阿里云API
      const response = await axios.post(
        this.baseUrl,
        {
          model: this.model,
          input: {
            prompt: prompt
          },
          parameters: {
            ...finalConfig
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          }
        }
      );

      if (response.status === 200) {
        return response.data.output.text || "";
      } else {
        throw new Error(`阿里云API错误: ${response.status}`);
      }
    } catch (e) {
      console.error(`调用模型时出错: ${e.message}`);
      throw e;
    }
  }
}

// 初始化模型
const llm = new QwenLLM();

// 输出模型验证函数
function validateOutfitResponse(data) {
  const requiredFields = ['readable_plan', 'image_prompt', 'summary'];
  for (const field of requiredFields) {
    if (!data[field]) {
      data[field] = "";
    }
  }
  return data;
}

// 格式指令
const formatInstructions = `
请按照以下JSON格式返回响应:
{
  "readable_plan": "穿搭方案的详细内容（Markdown格式）",
  "image_prompt": "用于AI图像生成的文生图提示词",
  "summary": "穿搭方案的简要总结（用于对话历史）"
}
`;

// 生成穿搭方案的提示模板
const generateOutfitPrompt = (data) => `
你是一位专业的服装搭配顾问，请根据以下信息提供一套专业的穿搭方案:
---------------------------------
天气信息: ${data.weather || ''}
幸运颜色: ${data.lucky_color || ''}
日程信息: ${data.schedule || ''}
场景: ${data.scene || ''}
突出特点: ${data.features || ''}
补充说明: ${data.additional_info || ''}
---------------------------------
以下是我在网上找到的一些相关穿搭信息:
${data.search_results || ''}
---------------------------------

请提供一套更新后的完整穿搭方案，包括:
1. 易读方案: 使用结构分明的Markdown格式，提供用户友好的穿搭建议详细描述，尽量详细全面。使用标题、项目符号、分段等Markdown格式元素使内容易于阅读,中文描述。
2. 文生图提示词: 一段详细的中文描述，可用于AI图像生成。必须使用中文编写，包含服装细节、风格、场景等信息。
3. 对话历史: 依靠所有以上对话进行对话总结200字左右，不要列举，只需要字符串，可以从以下方面进行，用于后续参考:
   - 用户提供的原始信息
   - 生成的穿搭方案
   - 用户反馈和修改意见
   - 方案调整过程

${formatInstructions}
`;

// 编辑穿搭方案的提示模板
const editOutfitPrompt = (data) => `
你是一位专业的服装搭配顾问，请根据以下信息和用户的编辑意见，提供一套更新后的专业穿搭方案:

原始信息:
之前方案: ${data.previous_plan || ''}
---------------------------------
对话历史: ${data.additional_info || ''}
---------------------------------
用户的编辑意见:
${data.edited_plan || ''}
---------------------------------
请提供一套更新后的完整穿搭方案，包括:
1. 易读方案: 使用结构分明的Markdown格式，提供用户友好的穿搭建议详细描述，尽量详细全面。使用标题、项目符号、分段等Markdown格式元素使内容易于阅读,中文描述。
2. 文生图提示词: 一段详细的中文描述，可用于AI图像生成。必须使用中文编写，包含服装细节、风格、场景等信息。
3. 对话历史: 依靠所有以上对话进行对话总结200字左右，在原对话信息的基础上只增不减，并且要记录此次对话信息，不要列举，只需要字符串，可以从以下方面进行，用于后续参考:
   - 用户提供的原始信息
   - 生成的穿搭方案
   - 用户反馈和修改意见
   - 方案调整过程

${formatInstructions}
`;

// 处理LLM响应
function processLLMResponse(response) {
  if (typeof response === 'object') {
    if (response.text) {
      response = response.text;
    } else {
      response = JSON.stringify(response);
    }
  }
  
  try {
    // 如果响应是JSON字符串，尝试解析它
    if (response.trim().startsWith('{') || response.trim().startsWith('```json')) {
      // 移除可能的Markdown代码块标记
      const cleanResponse = response.replace(/```json|```/g, '').trim();
      // 解析JSON
      const jsonData = JSON.parse(cleanResponse);
      return validateOutfitResponse(jsonData);
    }
  } catch (e) {
    console.error(`JSON解析错误: ${e.message}`);
    console.error(`原始响应: ${response}`);
  }
  
  // 如果解析失败，返回默认响应
  return {
    error: "无法解析响应",
    readable_plan: "",
    image_prompt: "",
    summary: ""
  };
}

// 生成穿搭方案API端点
app.post('/generate_outfit', async (req, res) => {
  try {
    const data = req.body;
    
    // 提取用户输入信息
    const weather = data.weather || '';
    const lucky_color = data.lucky_color || '';
    const schedule = data.schedule || '';
    const scene = data.scene || '';
    const features = data.features || '';
    const additional_info = data.additional_info || '';
    
    // 构建搜索查询
    const search_query = `穿搭建议 ${scene} ${weather} ${lucky_color}`;
    const search_results = await tavilyClient.search(search_query);
    
    // 生成穿搭方案
    try {
      const prompt = generateOutfitPrompt({
        weather,
        lucky_color,
        schedule,
        scene,
        features,
        additional_info,
        search_results
      });
      
      const response = await llm.invoke({ prompt });
      const result = processLLMResponse(response);
      
      res.json(result);
    } catch (chain_error) {
      console.error(`Chain执行错误: ${chain_error.message}`);
      throw chain_error;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 编辑穿搭方案API端点
app.post('/edit_outfit', async (req, res) => {
  try {
    const data = req.body;
    
    const previous_plan = data.previous_plan || '';
    const additional_info = data.additional_info || '';
    const edited_plan = data.edited_plan || '';
    
    // 生成更新后的穿搭方案
    const prompt = editOutfitPrompt({
      previous_plan,
      additional_info,
      edited_plan
    });
    
    const response = await llm.invoke({ prompt });
    const result = processLLMResponse(response);
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 健康检查路由
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server_ip: SERVER_IP,
    service_name: SERVICE_NAME,
    nacos_server: NACOS_SERVER_ADDR,
    nacos_namespace: NACOS_NAMESPACE
  });
});

// 通义千问视觉语言模型类
class QwenVL {
  constructor(apiKey = null, model = "qwen-vl-plus") {
    this.apiKey = apiKey || "sk-8b17bc160ce4413388fa1a0362934e31";
    this.model = model;
    this.baseUrl = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  }

  async analyzeImage(imageData, prompt) {
    try {
      // 处理图像数据
      let imageBase64;
      
      if (Buffer.isBuffer(imageData)) {
        // 添加base64前缀
        imageBase64 = `data:image/jpeg;base64,${imageData.toString('base64')}`;
      } else if (typeof imageData === 'string') {
        // 如果已经是base64字符串，确保有正确的前缀
        if (!imageData.startsWith('data:image')) {
          imageBase64 = `data:image/jpeg;base64,${imageData}`;
        } else {
          imageBase64 = imageData;
        }
      } else {
        throw new Error(`不支持的图像数据类型: ${typeof imageData}`);
      }
      
      console.log(`图像base64前50个字符: ${imageBase64.substring(0, 50)}...`);
      
      // 使用base64格式的图像数据调用API
      const response = await axios.post(
        this.baseUrl,
        {
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { image: imageBase64 },
                { text: prompt }
              ]
            }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          }
        }
      );
      
      // 打印完整响应结构以便调试
      console.log(`API响应类型: ${typeof response.data}`);
      console.log(`API响应结构: ${JSON.stringify(response.data, null, 2).substring(0, 500)}...`);
      
      // 从响应中提取文本
      if (response.status === 200) {
        if (response.data.output && response.data.output.choices) {
          return response.data.output.choices[0].message.content[0].text;
        } else if (typeof response.data.output === 'string') {
          return response.data.output;
        } else {
          return JSON.stringify(response.data.output);
        }
      } else {
        throw new Error(`通义千问API错误: ${response.status}`);
      }
    } catch (e) {
      console.error(`分析图像时出错: ${e.message}`);
      throw e;
    }
  }
}

// 初始化视觉模型
const qwenVl = new QwenVL();

// 处理图像数据
async function processImage(imageData = null, imagePath = null) {
  try {
    if (imagePath) {
      // 从URL获取图像
      const response = await axios.get(imagePath, {
        responseType: 'arraybuffer',
        timeout: 10000
      });
      
      if (response.status !== 200) {
        throw new Error(`获取图像失败，状态码: ${response.status}`);
      }
      
      return Buffer.from(response.data);
    } else if (imageData) {
      // 处理base64编码的图像
      if (typeof imageData === 'string') {
        // 移除base64前缀（如果存在）
        if (imageData.startsWith('data:image')) {
          imageData = imageData.split(',')[1];
        }
        // 解码base64数据
        return Buffer.from(imageData, 'base64');
      } else if (Buffer.isBuffer(imageData)) {
        // 如果已经是二进制数据，直接返回
        return imageData;
      } else {
        // 其他类型，尝试转换为字符串
        try {
          return Buffer.from(String(imageData), 'utf-8');
        } catch (e) {
          throw new Error(`不支持的图像数据类型: ${typeof imageData}`);
        }
      }
    } else {
      throw new Error("必须提供image_data或image_path参数");
    }
  } catch (e) {
    console.error(`处理图像时出错: ${e.message}`);
    throw e;
  }
}

// 图像分析提示模板
const imageAnalysisPrompt = `
请分析这张图片中人物的穿着和特征，提供以下信息：

1. 附加描述信息：请详细描述人物性别和预估年龄范围
2. 优点：分析这套穿搭的优势和亮点
3. 不足：分析这套穿搭的不足之处
4. 建议：给出具体的改进建议
5. 评分：给这套穿搭打分（1-10分）

请按以下JSON格式返回结果:
{
  "description": "包含性别和预估年龄的详细描述",
  "advantages": "穿搭的优点分析",
  "disadvantages": "穿搭的不足分析",
  "suggestions": "具体的穿搭建议",
  "score": 数字评分（1-10之间的整数）
}
`;

// 分析图片中人物信息API端点
app.post('/analyze_person', async (req, res) => {
  try {
    const data = req.body;
    
    // 获取图像数据（路径或base64）
    const imagePath = data.image_path;
    const imageData = data.image_data;
    
    if (!imagePath && !imageData) {
      return res.status(400).json({ error: "必须提供image_path或image_data参数" });
    }
    
    // 处理图像
    try {
      const processedImage = await processImage(imageData, imagePath);
      
      // 使用视觉模型分析图像
      const response = await qwenVl.analyzeImage(processedImage, imageAnalysisPrompt);
      
      // 尝试解析JSON响应
      try {
        // 打印原始响应用于调试
        console.log(`原始响应: ${response}`);
        
        // 移除响应前的非JSON文本
        let result = {};
        if (response.includes('{')) {
          const jsonStart = response.indexOf('{');
          let cleanedText = response.substring(jsonStart);
          
          // 处理可能存在的格式问题
          cleanedText = cleanedText.replace(/\n/g, ' ').replace(/\\n/g, ' ');
          cleanedText = cleanedText.replace(/",\\n"/g, '","');
          cleanedText = cleanedText.replace(/"},\\n"/g, '"},"');
          
          // 确保只保留一个完整的JSON对象
          if (cleanedText.includes('}')) {
            const jsonEnd = cleanedText.lastIndexOf('}') + 1;
            cleanedText = cleanedText.substring(0, jsonEnd);
          }
          
          // 尝试解析修复后的JSON
          console.log(`清理后的JSON: ${cleanedText}`);
          result = JSON.parse(cleanedText);
        }
        
        // 确保所有必需的字段都存在
        const requiredFields = ["description", "advantages", "disadvantages", "suggestions", "score"];
        for (const field of requiredFields) {
          if (!(field in result)) {
            if (field === "score") {
              // 如果缺少分数字段，默认设为7分
              result[field] = 7;
            } else {
              // 对于其他缺失字段，设置为空字符串
              result[field] = "";
            }
          }
        }
        
        // 确保score是整数类型
        if ("score" in result && !Number.isInteger(result.score)) {
          try {
            // 尝试将score转换为整数
            const scoreStr = String(result.score).trim();
            // 提取数字部分
            const scoreMatch = scoreStr.match(/\d+/);
            if (scoreMatch) {
              result.score = parseInt(scoreMatch[0], 10);
            } else {
              result.score = 7; // 默认分数
            }
          } catch (e) {
            result.score = 7; // 转换失败时使用默认分数
          }
        }
        
        return res.json(result);
      } catch (jsonError) {
        console.error(`JSON解析错误: ${jsonError.message}`);
        console.error(`原始响应: ${response}`);
        
        // 返回一个结构化但提示错误的响应
        return res.json({
          description: "JSON解析失败，但尽力提取了部分信息",
          advantages: "请查看raw_response获取完整响应",
          disadvantages: "原始响应无法被解析为有效JSON",
          suggestions: "请检查API返回格式或联系技术支持",
          score: 5, // 默认中等分数
          raw_response: response
        });
      }
    } catch (imageError) {
      return res.status(400).json({ error: `图像处理失败: ${imageError.message}` });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// 启动应用
async function startApp() {
  // 注册服务到Nacos
  await registerService();
  
  // 启动心跳定时器
  const heartbeatInterval = setInterval(sendHeartbeat, 5000);
  
  // 启动Express服务器
  const server = app.listen(SERVER_PORT, '0.0.0.0', () => {
    logger.info(`服务已启动，监听端口: ${SERVER_PORT}`);
  });
  
  // 处理进程退出
  process.on('SIGINT', async () => {
    clearInterval(heartbeatInterval);
    await deregisterService();
    server.close(() => {
      logger.info('应用已正常关闭');
      process.exit(0);
    });
  });
}

// 启动应用
startApp().catch(err => {
  logger.error(`启动应用失败: ${err.message}`);
  process.exit(1);
});  
