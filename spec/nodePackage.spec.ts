import {Directory} from "../src/directory";
import {File} from "../src/file";
import {NodePackage} from "../src/nodePackage";
import {tmpDir} from "./specHelpers";


describe("NodePackage", () => {


    describe("static", () => {


        describe("fromDirectory", () => {


            it("will reject when given a non-existent directory", (done) => {
                const dir = new Directory(__dirname, "xyzzy");
                NodePackage.fromDirectory(dir)
                .catch(() => {
                    done();
                });
            });


            it("will reject when given a directory that does not have a package.json file", (done) => {
                const dir = new Directory(__dirname);
                NodePackage.fromDirectory(dir)
                .catch(() => {
                    done();
                });
            });


            it("will create a new instance when given a valid directory", (done) => {
                const dir = new Directory(__dirname, "..");
                NodePackage.fromDirectory(dir)
                .then((pkg: NodePackage) => {
                    expect(pkg).toBeTruthy();
                    done();
                });
            });


        });


    });


    describe("instance", () => {


        describe("pack()", () => {


            it("will produce a .tgz file", (done) => {
                const pkgDir = new Directory(__dirname, "..");
                const pkg = new NodePackage(pkgDir);
                pkg.pack()
                .then((packedFile: File) => {
                    expect(packedFile).toBeTruthy();
                    expect(packedFile.fileName).toMatch(/publish-to-git-\d+\.\d+\.\d+\.tgz/);
                    expect(packedFile.existsSync()).toBeTruthy();
                    done();
                });
            });


            it("will place the .tgz in the package directory when an output directory is not specified", (done) => {
                const pkgDir = new Directory(__dirname, "..");
                const pkg = new NodePackage(pkgDir);
                pkg.pack()
                .then((packedFile: File) => {
                    expect(packedFile).toBeTruthy();
                    expect(packedFile.existsSync()).toBeTruthy();
                    expect(packedFile.directory.toString()).toEqual(pkgDir.toString());
                    done();
                });
            });


            it("will place the .tgz is the specified output directory", (done) => {
                const pkgDir = new Directory(__dirname, "..");
                const pkg = new NodePackage(pkgDir);
                pkg.pack(tmpDir)
                .then((packedFile: File) => {
                    expect(packedFile).toBeTruthy();
                    expect(packedFile.existsSync()).toBeTruthy();
                    expect(packedFile.directory.toString()).toEqual(tmpDir.toString());
                    done();
                });
            });



        });


    });

});