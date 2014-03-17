/**
 * Created by @kazaff on 14-3-4.
 */
"use strict";

var Cluster = require("cluster");
if(Cluster.isMaster){

    var numCPUs = require("os").cpus().length;
    for(var i = 0; i < numCPUs; i++){
        Cluster.fork();
    }

    Cluster.on("disconnect", function(worker, code, signal){
        console.log("worker %d died (%s). restarting...", worker.process.pid, signal || code);
        Cluster.fork();
    });

}else{      //Worker

    //加载config
    var Config = require("./config");
    var Restify = require("restify");
    var Auth = require("./auth");
    var Balancing = require("./balancing");
    var Domain = require("domain");

    //设置跨域的自定义请求头
    Restify.CORS.ALLOW_HEADERS.push("auth");

    var server = Restify.createServer({name: "Gate Server"});
    //该服务不需要支持长链接
    server.use(function(req, res, next){
        res.header("Connection", "Close");
        return next();
    });

    //处理 uncaughtException
    process.on("uncaughtException", function(err){
        console.log("uncaughtException", err);

        try{
            var killTimer = setTimeout(function(){
                process.exit(1);
            }, 30000);
            killTimer.unref();

            server.close();

            if(Cluster.isWorker){
                Cluster.worker.disconnect();
            }

        }catch(err){
            console.log("uncaughtException", err.stack);
        }
    });


    server.use(function(req, res, next){
        var reqDomain = Domain.create();
        reqDomain.on("error", function(err){
            console.log("Domain err", err);

            try{
                res.send(500);

                var killTimer = setTimeout(function(){
                    process.exit(1);
                }, 30000);
                killTimer.unref();

                server.close();

                if(Cluster.isWorker){
                    Cluster.worker.disconnect();
                }

            }catch(err){
                console.log("Domain err", err.stack);
            }
        });

        reqDomain.add(req);
        reqDomain.add(res);

        reqDomain.run(next);
    });

    //开启跨域支持
    server.use(Restify.CORS());
    server.use(Restify.fullResponse());

    server.use(Restify.acceptParser(server.acceptable));
    server.use(Restify.bodyParser({mapParams: false}));
    server.use(Restify.dateParser(30));

    //映射系统消息发送接口
    server.post("/message", function(req, res, next){

        //获取消息服务器真实地址
        var api = Balancing.poll(Config.servers);
        api = (api.protocol ? api.protocol : "http") + "://" + api.host + ":" + api.port;
        //console.log(api);

        //转发
        var client = Restify.createJsonClient({
            url: api
            , headers: {
                "AUTH": req.header("auth")
            }
        });
        client.post("/message", req.body, function(err, request, response, obj){
            if(err){
                return next(err);
            }

            res.send(obj);
            next();
        });
    });

    //映射系统公告发送接口
    server.post("/boradcast", function(req, res, next){

        //获取消息服务器真实地址
        var api = Balancing.poll(Config.servers);
        api = (api.protocol ? api.protocol : "http") + "://" + api.host + ":" + api.port;

        //转发
        var client = Restify.createJsonClient({
            url: api
            , headers: {
                "AUTH": req.header("auth")
            }
        });
        client.post("/boradcast", req.body, function(err, request, response, obj){
            if(err){
                return next(err);
            }

            res.send(obj);
            next();
        });
    });

    //验证用户身份
    server.use(function auth(req, res, next){

        var token = req.header("auth");
        if(!token){
            return next(new Restify.UnauthorizedError("authentication required"));
        }

        //获取用户信息
        Auth.verify(req, Config.appId, Config.api, token, Config.token, next);

        return;
    });

    server.get("/entity", function getEntity(req, res, next){

        //返回指定node服务地址
        var target;
        try{
            target = Balancing.poll(Config.servers);
        }catch(err){
            return next(err);
        }

        console.log("Worker " + Cluster.worker.id + " handle!");
        //throw new Error("test");

        res.send(target);
        return next();
    });

    server.listen(Config.port, Config.host, function(){
        console.log("%s listening at %s", server.name, server.url);
    });
}