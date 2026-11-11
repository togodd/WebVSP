#!/usr/bin/env python3
"""Focused native Texture::EncodeXml regression; run: python3 test_texture_encode_xml.py.

Compiles the actual Texture.cpp and Vehicle path functions with isolated, minimal
Parm/XML/manager stubs. This is not a full OpenVSP or XML-library integration test.
Requires a C++17 compiler (CXX, default c++). All build files live in a temp dir.
"""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent


def function(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth = 0
    for pos in range(opening, len(source)):
        if source[pos] == '{':
            depth += 1
        elif source[pos] == '}':
            depth -= 1
            if depth == 0:
                return source[start:pos + 1]
    raise ValueError('unclosed function: ' + signature)


STUB = r'''
#pragma once
#include <algorithm>
#include <filesystem>
#include <string>
using std::string;
struct Node { std::string value; };
using xmlNodePtr = Node*;
struct XmlUtil {
    static void AddStringNode(xmlNodePtr node, const char*, const std::string& value) { node->value = value; }
    static std::string FindString(xmlNodePtr node, const char*, const std::string&) { return node->value; }
};
struct ParmContainer {
    virtual ~ParmContainer() = default;
    void SetName(const std::string&) {}
    xmlNodePtr EncodeXml(xmlNodePtr& node) { return node; }
    xmlNodePtr DecodeXml(xmlNodePtr& node) { return node; }
};
struct Parm {
    void Init(const char*, const char*, ParmContainer*, double, double, double) {}
    void Set(bool) {}
};
using BoolParm = Parm;
struct StringUtil {
    static void change_from_to(std::string& s, char from, char to) { std::replace(s.begin(), s.end(), from, to); }
};
struct Vehicle {
    std::string m_VSP3FileName;
    void MakeRelativePath(std::string&);
    void MakeAbsolutePath(std::string&);
};
struct Manager { Vehicle* vehicle = nullptr; Vehicle* GetVehicle() { return vehicle; } };
extern Manager VehicleMgr;
'''

TEST = r'''
#include "Texture.h"
#include "Vehicle.h"
#include <iostream>
#include <stdexcept>
Manager VehicleMgr;

static void check(Texture& texture, Vehicle* vehicle, const std::string& original) {
    VehicleMgr.vehicle = vehicle;
    std::string expected = original;
    bool expected_error = false;
    try { if (vehicle) vehicle->MakeRelativePath(expected); }
    catch (const std::filesystem::filesystem_error&) { expected_error = true; }
    Node node;
    xmlNodePtr ptr = &node;
    bool actual_error = false;
    try { texture.EncodeXml(ptr); }
    catch (const std::filesystem::filesystem_error&) { actual_error = true; }
    if (actual_error != expected_error || (!actual_error && node.value != expected) || texture.m_FileName != original)
        throw std::runtime_error("EncodeXml changed path or XML behavior for: " + original);
}
int main() {
    const std::string root = std::filesystem::current_path().generic_string();
    Vehicle vehicle;
    const std::string inputs[] = {root + "/assets/texture.jpg", "assets/texture.jpg", "", "../elsewhere/img.tga"};
    for (const auto& input : inputs) {
        Texture texture(input);
        check(texture, nullptr, input);
        vehicle.m_VSP3FileName = "Unnamed.vsp3";
        check(texture, &vehicle, input);
        vehicle.m_VSP3FileName = root + "/first/model.vsp3";
        check(texture, &vehicle, input);
        check(texture, &vehicle, input);
        vehicle.m_VSP3FileName = root + "/second/model.vsp3";
        check(texture, &vehicle, input);
    }
    std::cout << "Texture EncodeXml regression passed\n";
}
'''


def main():
    source = (ROOT / 'src/geom_core/Vehicle.cpp').read_text(encoding='utf-8')
    relative = function(source, 'void Vehicle::MakeRelativePath( string & fname )')
    absolute = function(source, 'void Vehicle::MakeAbsolutePath( string & fname )')
    with tempfile.TemporaryDirectory(prefix='texture-encode-test-') as tmp:
        temp = Path(tmp)
        for name in ('Texture.cpp', 'Texture.h'):
            (temp / name).write_bytes((ROOT / 'src/geom_core' / name).read_bytes())
        (temp / 'stub.h').write_text(STUB, encoding='utf-8')
        for name in ('ParmContainer.h', 'Parm.h', 'StringUtil.h', 'Vehicle.h'):
            (temp / name).write_text('#include "stub.h"\n', encoding='utf-8')
        (temp / 'vehicle.cpp').write_text('#include "stub.h"\n' + relative + '\n' + absolute + '\n', encoding='utf-8')
        (temp / 'test.cpp').write_text(TEST, encoding='utf-8')
        (temp / 'first').mkdir()
        (temp / 'second').mkdir()
        command = shlex.split(os.environ.get('CXX', 'c++')) + ['-std=c++17', '-Wall', '-Wextra', '-pedantic', 'Texture.cpp', 'vehicle.cpp', 'test.cpp', '-o', 'texture_test']
        subprocess.run(command, cwd=temp, check=True)
        subprocess.run([str(temp / 'texture_test')], cwd=temp, check=True)


if __name__ == '__main__':
    main()
