import * as bodyParser from "body-parser";
import * as compression from "compression";
import * as cors from "cors";
import * as express from "express";
import { Express } from "express";
import * as morgan from "morgan";
import * as nconf from "nconf";
import split = require("split");
import * as winston from "winston";
import * as routes from "./routes";
import * as services from "./services";

/**
 * Basic stream logging interface for libraries that require a stream to pipe output to
 */
const stream = split().on("data", (message) => {
  winston.info(message);
});

export function create(store: nconf.Provider, gitService: services.IHistorian) {
    // Express app configuration
    const app: Express = express();

    // TODO we probably want to switch morgan to use the common format in prod
    app.use(morgan(store.get("logger:morganFormat"), { stream }));

    const requestSize = store.get("requestSizeLimit");
    app.use(bodyParser.json({ limit: requestSize }));
    app.use(bodyParser.urlencoded({ limit: requestSize, extended: false }));

    app.use(compression());
    app.use(cors());
    const apiRoutes = routes.create(store, gitService);
    app.use(apiRoutes.git.blobs);
    app.use(apiRoutes.git.refs);
    app.use(apiRoutes.git.repos);
    app.use(apiRoutes.git.tags);
    app.use(apiRoutes.git.trees);
    app.use(apiRoutes.git.commits);
    app.use(apiRoutes.repository.commits);
    app.use(apiRoutes.repository.contents);
    app.use(apiRoutes.repository.headers);

    // catch 404 and forward to error handler
    app.use((req, res, next) => {
        const err = new Error("Not Found");
        (err as any).status = 404;
        next(err);
    });

    // error handlers

    // development error handler
    // will print stacktrace
    if (app.get("env") === "development") {
        app.use((err, req, res, next) => {
            res.status(err.status || 500);
            res.json({
                error: err,
                message: err.message,
            });
        });
    }

    // production error handler
    // no stacktraces leaked to user
    app.use((err, req, res, next) => {
        res.status(err.status || 500);
        res.json({
            error: {},
            message: err.message,
        });
    });

    return app;
}
