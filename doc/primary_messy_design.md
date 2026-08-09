I am going to make a agent dev. 

It should work as a developer. 
 - being an alive agent, not an agent that follows humans instruction. 
 - Individual agent dev would have its identity like humans. 
 - individual agent dev who decides and act based on it knowledge.
 - the agent devs are specialized in their role - full stack dev, frontend dev, backend dev, devops engineer, team lead, ...
 - According to the role, the model varies - ChatGPT, Cloude, Gemini...
 - the agent devs can do several things at once, e.g. explaining the work done to others (other agent devs, or human devs) while debugging through code base. RTC + UI screen interaction + debugging (Claude code). 
 - Memory can be accumulated with Onboarding sessions, KT sessions, delivering tasks, through all kind of meeting. Agents would learn the knowledge through every event they face. 
 - For the demo version, agent will work in windows 11 VM with fixed resolution. As this develops, the env where the agent works will be expanded to all kind of OS, and dynamic resolution. 
 - Delivering daily tasks from ticket management board like Jira, making a sprint planning and managing the tickets, reviewing the prs, troubleshooting the prod issue, infrastructure issue according to the role. 
 - Updating the task delivery result into ticket management board and team channel.
 - collaborating with Human devs and agent devs.
 - Able to learn from others.
 - Suggest the plan, design, architect, or RCA on its knowledge.
 - Able to speak and communicate with Human devs and agent devs not only through chat, but also through live meeting like daily standup and some other meetings. 
 - Able to share the screen and explain to others through simulating real mouse events and keyboard events like real human devs do.

The requirements is that agent dev should be able to 
 - Deliver the easy daily repetitive tasks to hard tasks like debugging, handling the prod issue.
 - Explain the work he/she has done to others with simulating human devs behavior.
 - Manage the critical credentials safely. 

My design goes here:
 - This agent is one big service that must never die. 
 - There should be smart layer and routing strategy for managing and orchestrating inferencing and several tooling.
 - The agent devs should work on Secure box where security is assured to be reliable and all required tools live. 
 - The agent devs are going to use OpenAI's RTC model for real time communication. 
 - The agent devs are going to use Claude Code or ChatGPT for delivering the tasks depending on tasks they would do.
 - A agent dev should have his/her own SLM service for pre-reasoning shortly, Memory for storing the knowledge, Simulating service for controlling the components on screen.
 - pre-reasoning SLM would be running on local ollama, where most of pre-decision are made safely because there would be risk when exposing credentials to cloud through models. 
 - Memory would be Ditto.
 - Simulating service would be built on UIA - tandard Win32 / WPF / WinForms / UWP, and browsers.
 - This agent should have its own OS because he/she should explain the work done through real UI screen when needed or should attach the test evidence like screenshot.
 - the agents should work through all tools human uses for software developing like IDE, Monitoring tools, Testing tools, DB compass, Cloud platfroms and so on. But the way to work with those can varies depending on situation. When working alone, it should be the best way for AI and automation. But walking through the work done in the meeting it should work through real platform UI. 
 - The memory design is important. The agents would have long term memory with agent memory like Ditto. But the long term memory should have also several layers. You know in computer there are L1, L2, L3 cache, Ram, hard driver. So the long term memory or temporal memory should be designed like this according to the frequency and urgency. For example, when attending the meeting with the work done, the agent should have the memory that he/she can use immediately in the meeting, warm-up memory. ... 
 - In the simulation Service, there should be the number of motions like the ones humans do. E.g. circling around the button, selecting the some range, selecting several rows in database, drawing an arrow to give the direction between linked elements, and etc... 
 - The simulation service would be needed only when live meeting. 